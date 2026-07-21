/**
 * App Proxy route — handles all /apps/wholesale/* storefront requests.
 *
 * Shopify routes `https://store.myshopify.com/apps/wholesale/*` to this handler.
 * The HMAC signature on every request is verified by authenticate.public.appProxy().
 * The `logged_in_customer_id` param is included in the HMAC, so it is trustworthy.
 *
 * GET  /apps/wholesale/prices?product_id=<numeric_id>[&qty=<n>]
 *   → Returns wholesale pricing for every variant of the product.
 *
 * GET  /apps/wholesale/order-minimums
 *   → Returns the active order minimum config.
 *
 * POST /apps/wholesale/backorder  (body: variant_id, product_id, quantity)
 *   → Creates a Shopify Draft Order for a wholesale backorder (bypasses inventory).
 *     Returns { ok, order_name, invoice_url } on success.
 *
 * All responses are JSON. Non-wholesale customers receive { wholesale: false }.
 */

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  getWholesaleSession,
  getEffectiveOrderMinimum,
} from "../lib/wholesale-customer.server";
import {
  getCmsVariantMap,
  maybeRefreshCmsCache,
  parseHiddenVariantIds,
  resolveVariantWholesale,
} from "../lib/cms-client.server";
import { db } from "../db.server";

// Wholesale availability (all endpoints): a variant is wholesale iff it has a
// CMS row AND is not in the product's custom.wholesale_hidden_variants
// metafield AND the product is ACTIVE. No fallback pricing — not in the CMS
// means not wholesale. See resolveVariantWholesale in cms-client.server.ts.

// Admin API query — fetches active products for the line sheet (paginated).
const LINESHEET_QUERY = `
  query GetLinesheetProducts($first: Int!, $after: String) {
    shop { currencyCode }
    products(first: $first, after: $after, query: "status:active") {
      edges {
        node {
          id
          title
          handle
          status
          featuredImage { url altText }
          hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
          variants(first: 100) {
            nodes {
              id
              title
              sku
              availableForSale
              inventoryQuantity
              price
              image { url }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Admin API query — fetches variant prices and inventory for a product.
// (Uses the Admin API, not the Storefront API: the app has read_products/read_inventory
// admin scopes but no unauthenticated_* Storefront scopes, so the Storefront API returns 403.)
const PRODUCT_QUERY = `
  query GetProductVariants($id: ID!) {
    shop { currencyCode }
    product(id: $id) {
      id
      title
      handle
      status
      hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          availableForSale
          inventoryQuantity
          price
          selectedOptions {
            name
            value
          }
          image {
            url
            altText
          }
        }
      }
    }
  }
`;

// Admin API query — validates a single variant for backorder creation.
const VARIANT_QUERY = `
  query GetVariantForBackorder($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      price
      product {
        id
        status
        tags
        hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
      }
    }
  }
`;

// ── Draft-order shipping ──────────────────────────────────────────────────────
// The "Wholesale Free Shipping" Shopify Function can never activate on this
// store — functions from custom-distribution apps require Shopify Plus. So
// free shipping is applied here instead: a $0 shippingLine set on the draft
// orders the app creates, which the invoice checkout presents as the only
// shipping method. Products tagged `no-free-shipping-wholesale` (heavy items)
// suppress the line — staff price real freight on the draft before invoicing.
const NO_FREE_SHIPPING_TAG = "no-free-shipping-wholesale";
const FREE_SHIPPING_LINE = { title: "Wholesale Free Shipping", price: "0.00" };
const OWN_LABEL_SHIPPING_LINE = {
  title: "Customer's own shipping label",
  price: "0.00",
};

function productHasNoFreeShippingTag(product: any): boolean {
  return (product?.tags ?? []).includes(NO_FREE_SHIPPING_TAG);
}

// Best-effort: free shipping only applies to US wholesale, judged by the
// customer's default address. Unknown/missing address → no line (checkout
// falls back to the store's normal paid rates).
async function customerDefaultAddressIsUS(
  admin: { graphql: Function },
  customerGid: string
): Promise<boolean> {
  try {
    const res = await admin.graphql(
      `query CustomerCountryForShipping($id: ID!) {
        customer(id: $id) { defaultAddress { countryCodeV2 } }
      }`,
      { variables: { id: customerGid } }
    );
    const body = await res.json();
    return body.data?.customer?.defaultAddress?.countryCodeV2 === "US";
  } catch (err) {
    console.error("[app-proxy] customer country lookup failed:", err);
    return false;
  }
}

function notWholesale() {
  return json(
    { wholesale: false },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}

function proxyJson(data: unknown) {
  return json(data, { headers: { "Cache-Control": "no-store" } });
}

// ── Linesheet draft persistence helpers ──────────────────────────────────────
// One active DRAFT row per customer (latest wins); SUBMITTED rows are the
// order history customers can duplicate into a new draft.

function sanitizeDraftLines(raw: unknown): Array<{ variant_id: number; quantity: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => ({
      variant_id: parseInt(String(l?.variant_id ?? "").replace(/\D/g, ""), 10),
      quantity: Math.floor(Number(l?.quantity)),
    }))
    .filter(
      (l) =>
        Number.isFinite(l.variant_id) &&
        l.variant_id > 0 &&
        Number.isFinite(l.quantity) &&
        l.quantity > 0
    )
    .slice(0, 250);
}

function parseDraftLines(stored: string): Array<{ variant_id: number; quantity: number }> {
  try {
    return sanitizeDraftLines(JSON.parse(stored));
  } catch {
    return [];
  }
}

async function getActiveDraft(shopifyCustomerId: string) {
  return db.linesheetDraft.findFirst({
    where: { shopifyCustomerId, status: "DRAFT" },
    orderBy: { updatedAt: "desc" },
  });
}

async function upsertActiveDraft(
  shopifyCustomerId: string,
  lines: Array<{ variant_id: number; quantity: number }>,
  subtotalCents: number
) {
  const existing = await getActiveDraft(shopifyCustomerId);
  const data = { lines: JSON.stringify(lines), subtotalCents };
  if (existing) {
    return db.linesheetDraft.update({ where: { id: existing.id }, data });
  }
  return db.linesheetDraft.create({ data: { shopifyCustomerId, ...data } });
}

// Customer-facing status of a submitted sheet, derived from its Shopify draft
// order. Status keys (display copy lives in orders.js): SUBMITTED (draft still
// open, not yet invoiced) → INVOICE_SENT → PREPARING (order created, not yet
// fulfilled) → PARTIALLY_SHIPPED → SHIPPED; CANCELLED if the order was
// cancelled OR the draft was deleted in Shopify Admin (staff cancelling an
// unpaid order); REFUNDED if a shipped order was returned and fully refunded.
// Sheets whose lookup fails fall back to SUBMITTED.
async function fetchDraftOrderStatuses(admin: any, draftOrderIds: string[]) {
  const map = new Map<
    string,
    {
      key: string;
      invoiceUrl: string | null;
      freightQuote: boolean;
      backorder: boolean;
      balanceDueCents: number;
      payBalanceUrl: string | null;
      tracking: Array<{ number: string | null; url: string | null; company: string | null }>;
    }
  >();
  if (draftOrderIds.length === 0) return map;
  try {
    const res = await admin.graphql(
      `query OrderSheetStatuses($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DraftOrder {
            id
            status
            invoiceUrl
            tags
            order {
              cancelledAt
              displayFulfillmentStatus
              displayFinancialStatus
              totalOutstandingSet { shopMoney { amount } }
              paymentCollectionDetails { additionalPaymentCollectionUrl }
              fulfillments(first: 10) {
                trackingInfo(first: 5) { number url company }
              }
            }
          }
        }
      }`,
      { variables: { ids: draftOrderIds.map((id) => `gid://shopify/DraftOrder/${id}`) } }
    );
    const body = await res.json();
    if (!body.data) throw new Error(JSON.stringify(body.errors ?? "no data"));
    for (const node of body.data.nodes ?? []) {
      if (!node?.id) continue;
      const numericId = String(node.id.split("/").pop());
      const order = node.order;
      let key = "SUBMITTED";
      let balanceDueCents = 0;
      let payBalanceUrl: string | null = null;
      const tracking: Array<{ number: string | null; url: string | null; company: string | null }> = [];
      if (order) {
        balanceDueCents = Math.round(
          parseFloat(order.totalOutstandingSet?.shopMoney?.amount ?? "0") * 100
        );
        payBalanceUrl =
          balanceDueCents > 0
            ? order.paymentCollectionDetails?.additionalPaymentCollectionUrl ?? null
            : null;
        for (const f of order.fulfillments ?? []) {
          for (const t of f.trackingInfo ?? []) {
            if (t.number || t.url) {
              tracking.push({ number: t.number, url: t.url, company: t.company ?? null });
            }
          }
        }
        if (order.cancelledAt) key = "CANCELLED";
        else if (order.displayFinancialStatus === "REFUNDED") key = "REFUNDED";
        else if (order.displayFulfillmentStatus === "FULFILLED") key = "SHIPPED";
        else if (order.displayFulfillmentStatus === "PARTIALLY_FULFILLED") key = "PARTIALLY_SHIPPED";
        else key = "PREPARING";
      } else if (node.status === "INVOICE_SENT") {
        key = "INVOICE_SENT";
      }
      const tags = (node.tags ?? []).map((t: string) => t.toLowerCase());
      const freightQuote = tags.includes("freight-quote");
      const backorder = tags.includes("backorder");
      // Some drafts must not be payable early even though Shopify mints an
      // invoiceUrl on every draft: freight orders (paying would let the retail
      // rate table price the freight) and backorders (invoiced when stock
      // arrives). The link appears once staff send the invoice (INVOICE_SENT).
      const invoiceUrl =
        key === "SUBMITTED" && (freightQuote || backorder) ? null : node.invoiceUrl ?? null;
      map.set(numericId, {
        key,
        invoiceUrl,
        freightQuote,
        backorder,
        balanceDueCents,
        payBalanceUrl,
        tracking,
      });
    }
    // Ids the query resolved to nothing: the draft was deleted in Shopify
    // Admin — that's how staff cancel an order that hasn't been paid yet.
    // (Transient lookup failures throw above and leave the map empty instead.)
    for (const id of draftOrderIds) {
      if (!map.has(id)) {
        map.set(id, {
          key: "CANCELLED",
          invoiceUrl: null,
          freightQuote: false,
          backorder: false,
          balanceDueCents: 0,
          payBalanceUrl: null,
          tracking: [],
        });
      }
    }
  } catch (err) {
    console.error("[app-proxy/orders] status lookup failed:", err);
  }
  return map;
}

// ── GET handler ──────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // Verifies the HMAC signature; logged_in_customer_id / shop in the query params are
  // trustworthy afterward. Product data is fetched via the Admin API (unauthenticated.admin)
  // rather than the Storefront API, which the app lacks unauthenticated_* scopes for.
  await authenticate.public.appProxy(request);

  // Kick off a background CMS cache refresh if data is stale (fire-and-forget).
  // Does nothing if CMS_BASE_URL / CMS_API_TOKEN are not set.
  void maybeRefreshCmsCache();

  const url = new URL(request.url);
  const subpath = (params["*"] ?? "").replace(/^\//, "");

  // ── /apps/wholesale/status ──────────────────────────────────────────────
  // Lightweight wholesale status check — DB only, no Storefront API call.
  // Used by wholesale.js as an async fallback on pages without the badge block.
  if (subpath === "status") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return notWholesale();
    return proxyJson({ wholesale: true, customerType: session.customerType });
  }

  // ── /apps/wholesale/order-minimums ──────────────────────────────────────
  if (subpath === "order-minimums") {
    // logged_in_customer_id is HMAC-signed — safe to use after appProxy verification.
    // Returns the customer's per-account override if set; otherwise the global config.
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const minimums = await getEffectiveOrderMinimum(shopifyCustomerId);
    return proxyJson(minimums);
  }

  // ── /apps/wholesale/linesheet-data ──────────────────────────────────────
  if (subpath === "linesheet-data") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return notWholesale();

    // Paginate through ALL active products — no artificial cap.
    // Shopify's API guarantees endCursor is defined whenever hasNextPage is true.
    // `shop` is in the HMAC-signed query params — safe after appProxy verification.
    const shop = url.searchParams.get("shop");
    if (!shop) {
      return json({ error: "Missing shop param" }, { status: 400 });
    }
    const { admin } = await unauthenticated.admin(shop);

    const allNodes: any[] = [];
    let shopCurrency = "USD";
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      let result: any;
      try {
        result = await admin.graphql(LINESHEET_QUERY, {
          variables: { first: 50, after: cursor },
        });
      } catch (err) {
        console.error("[app-proxy/linesheet-data] Admin API error:", err);
        return json({ error: "Failed to fetch products" }, { status: 502 });
      }

      const body = await result.json();
      shopCurrency = body.data?.shop?.currencyCode ?? shopCurrency;
      const products = body.data?.products;
      if (!products) break;

      allNodes.push(...products.edges.map((e: any) => e.node));
      hasNextPage = products.pageInfo.hasNextPage;
      cursor = products.pageInfo.endCursor;
    }

    // Bulk-fetch CMS pricing/MOQ for all variants in one DB query
    const allVariantIds = allNodes.flatMap((p: any) =>
      p.variants.nodes.map((v: any) => ({
        id: parseInt(v.id.split("/").pop(), 10),
        sku: v.sku,
      }))
    );
    const cmsMap = await getCmsVariantMap(allVariantIds);

    // One flat, alphabetized list — no grouping. (First-collection buckets
    // were arbitrary: multi-collection products landed wherever Shopify listed
    // them first, and section order was uncontrolled. Removed 2026-07-18.)
    // Only wholesale-available variants appear; products with none are left
    // off the line sheet. The client renders a section with an empty title as
    // a plain table, so the collections-array response shape is kept.
    const flatProducts: any[] = [];

    for (const product of allNodes) {
      const hiddenIds = parseHiddenVariantIds(product.hiddenVariants?.value);
      const productActive = product.status === "ACTIVE";

      const variants = product.variants.nodes.flatMap((v: any) => {
        const variantId = parseInt(v.id.split("/").pop(), 10);
        const retailCents = Math.round(parseFloat(v.price) * 100);
        const cms = cmsMap.get(String(variantId));
        const state = resolveVariantWholesale({
          cms,
          variantId,
          hiddenVariantIds: hiddenIds,
          productActive,
          customerType: session.customerType,
          retailCents,
        });
        if (!state.available) return [];

        // Distributors see BOTH prices: wh_price stays the wholesale price
        // and dist_price (their effective order price) rides alongside. For
        // everyone else wh_price is the effective price and dist_price null.
        const isDistributor = session.customerType === "DISTRIBUTOR";
        return [{
          id: variantId,
          title: v.title,
          sku: v.sku ?? "",
          retail_price: retailCents,
          wh_price: isDistributor ? cms!.wholesalePriceCents : state.priceCents,
          dist_price: isDistributor ? state.priceCents : null,
          currency_code: shopCurrency,
          available: v.availableForSale,
          in_stock: v.inventoryQuantity ?? 0,
          // Real MOQ even for exempt customers — they see it (informational,
          // with a courtesy note) but nothing enforces it (moq_exempt flag).
          moq: state.moq,
          case_size: state.caseSize,
          image_url: v.image?.url ?? null, // per-variant image; falls back to product image client-side
        }];
      });

      if (variants.length === 0) continue;

      flatProducts.push({
        id: parseInt(product.id.split("/").pop(), 10),
        title: product.title,
        handle: product.handle,
        image_url: product.featuredImage?.url ?? null,
        variants,
      });
    }

    flatProducts.sort((a, b) =>
      a.title.localeCompare(b.title, "en", { sensitivity: "base" })
    );

    return proxyJson({
      wholesale: true,
      moq_exempt: session.exemptFromMoq,
      collections: [{ title: "", products: flatProducts }],
    });
  }

  // ── /apps/wholesale/prices ───────────────────────────────────────────────
  if (subpath === "prices") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const productId = url.searchParams.get("product_id");

    if (!productId) {
      return json({ error: "product_id is required" }, { status: 400 });
    }

    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return notWholesale();

    // `shop` is in the HMAC-signed query params — safe after appProxy verification.
    const shop = url.searchParams.get("shop");
    if (!shop) {
      return json({ error: "Missing shop param" }, { status: 400 });
    }

    let productData: any;
    let shopCurrency = "USD";
    try {
      const { admin } = await unauthenticated.admin(shop);
      const gid = `gid://shopify/Product/${productId}`;
      const result = await admin.graphql(PRODUCT_QUERY, { variables: { id: gid } });
      const body = await result.json();
      productData = body.data?.product;
      shopCurrency = body.data?.shop?.currencyCode ?? "USD";
    } catch (err) {
      console.error("[app-proxy] Admin API error:", err);
      return json({ error: "Failed to fetch product data" }, { status: 502 });
    }

    if (!productData) {
      return json({ error: "Product not found" }, { status: 404 });
    }

    const variantIds = productData.variants.nodes.map((v: any) => ({
      id: parseInt(v.id.split("/").pop(), 10),
      sku: v.sku,
    }));
    const cmsMap = await getCmsVariantMap(variantIds);
    const hiddenIds = parseHiddenVariantIds(productData.hiddenVariants?.value);
    const productActive = productData.status === "ACTIVE";

    // Only wholesale-available variants are returned. The storefront JS shows
    // a "not available for wholesale" state for any selected variant missing
    // from this list, and reveals retail pricing when the list is empty
    // (product_wholesale: false).
    const variants = productData.variants.nodes.flatMap((v: any) => {
      const retailCents = Math.round(parseFloat(v.price) * 100);
      const variantId = parseInt(v.id.split("/").pop(), 10);
      const cms = cmsMap.get(String(variantId));
      const state = resolveVariantWholesale({
        cms,
        variantId,
        hiddenVariantIds: hiddenIds,
        productActive,
        customerType: session.customerType,
        retailCents,
      });
      if (!state.available) return [];

      // Distributors see BOTH prices (wholesale row + distributor row on the
      // PDP); their effective price is dist_price. See linesheet-data.
      const isDistributor = session.customerType === "DISTRIBUTOR";
      return [{
        id: variantId,
        gid: v.id,
        title: v.title,
        sku: v.sku ?? "",
        retail_price: retailCents,
        wh_price: isDistributor ? cms!.wholesalePriceCents : state.priceCents,
        dist_price: isDistributor ? state.priceCents : null,
        discount_percent: state.discountPercent,
        available: v.availableForSale,
        in_stock: v.inventoryQuantity ?? 0,
        // Real MOQ even for exempt customers — display only (moq_exempt flag
        // suppresses the qty-input enforcement client-side).
        moq: state.moq,
        case_size: state.caseSize,
        selected_options: v.selectedOptions,
        image_url: v.image?.url ?? null,
        currency_code: shopCurrency,
      }];
    });

    return proxyJson({
      wholesale: true,
      moq_exempt: session.exemptFromMoq,
      product_wholesale: variants.length > 0,
      product_id: productId,
      product_title: productData.title,
      variants,
    });
  }

  // ── /apps/wholesale/linesheet-draft (GET) ───────────────────────────────
  // The customer's active draft (for prefilling the linesheet) plus their
  // submitted-sheet history (for duplicating a previous order) and the
  // customer/shipping info shown top-right on the sheet.
  if (subpath === "linesheet-draft") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });

    // ?edit_of=<draftOrderId>: the sheet is editing an existing unpaid order —
    // serve the EDITING session row instead of the working draft (which is
    // never touched by an edit). edit_missing tells the client the session
    // is gone (expired/cancelled elsewhere) so it can fall back cleanly.
    const editOf = (url.searchParams.get("edit_of") || "").replace(/\D/g, "");
    let draft;
    let editMissing = false;
    if (editOf) {
      draft = await db.linesheetDraft.findFirst({
        where: {
          shopifyCustomerId: session.shopifyCustomerId,
          status: "EDITING",
          shopifyDraftOrderId: editOf,
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!draft) editMissing = true;
    } else {
      draft = await getActiveDraft(session.shopifyCustomerId);
    }
    const history = await db.linesheetDraft.findMany({
      where: { shopifyCustomerId: session.shopifyCustomerId, status: "SUBMITTED" },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });

    // Default shipping address from Shopify (best effort — panel renders
    // without it if the lookup fails).
    let address: string[] = [];
    const shop = url.searchParams.get("shop");
    if (shop) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const res = await admin.graphql(
          `query CustomerAddress($id: ID!) {
            customer(id: $id) {
              defaultAddress {
                address1 address2 city provinceCode zip countryCodeV2
              }
            }
          }`,
          { variables: { id: `gid://shopify/Customer/${session.shopifyCustomerId}` } }
        );
        const body = await res.json();
        const a = body.data?.customer?.defaultAddress;
        if (a) {
          address = [
            a.address1,
            a.address2,
            [a.city, a.provinceCode, a.zip].filter(Boolean).join(", "),
            a.countryCodeV2 === "US" ? null : a.countryCodeV2,
          ].filter(Boolean);
        }
      } catch (err) {
        console.error("[app-proxy/linesheet-draft] address lookup failed:", err);
      }
    }

    const customerRow = await db.wholesaleCustomer.findUnique({
      where: { shopifyCustomerId: session.shopifyCustomerId },
      select: { firstName: true, lastName: true, email: true, company: true },
    });

    return proxyJson({
      wholesale: true,
      edit_missing: editMissing,
      customer: {
        name:
          [customerRow?.firstName, customerRow?.lastName].filter(Boolean).join(" ") ||
          customerRow?.email ||
          "",
        company: customerRow?.company || "",
        email: customerRow?.email || "",
        address,
      },
      draft: draft
        ? {
            lines: parseDraftLines(draft.lines),
            po_number: draft.poNumber || "",
            ship_own_label: draft.shipOwnLabel,
            updated_at: draft.updatedAt,
          }
        : null,
      history: history.map((h) => ({
        id: h.id,
        order_name: h.orderName,
        subtotal_cents: h.subtotalCents,
        line_count: parseDraftLines(h.lines).length,
        submitted_at: h.updatedAt,
      })),
    });
  }

  // ── /apps/wholesale/orders ──────────────────────────────────────────────
  // Order history for the storefront Orders page. Without ?id= returns the
  // customer's submitted sheets (newest first) with live status from Shopify;
  // with ?id=<sheet id> returns one sheet with enriched line detail.
  if (subpath === "orders") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });

    const shop = url.searchParams.get("shop");
    if (!shop) return json({ error: "Missing shop param" }, { status: 400 });
    const { admin } = await unauthenticated.admin(shop);

    const detailId = url.searchParams.get("id");
    if (detailId) {
      // DRAFT sheets are reviewable here too — the Orders page is the order
      // review/submit surface, not just post-submission history.
      const sheet = await db.linesheetDraft.findFirst({
        where: {
          id: detailId,
          shopifyCustomerId: session.shopifyCustomerId,
          status: { in: ["DRAFT", "SUBMITTED"] },
        },
      });
      if (!sheet) return json({ error: "Order sheet not found" }, { status: 404 });

      const lines = parseDraftLines(sheet.lines);
      const statusMap = await fetchDraftOrderStatuses(
        admin,
        sheet.shopifyDraftOrderId ? [sheet.shopifyDraftOrderId] : []
      );
      const st =
        sheet.status === "DRAFT"
          ? { key: "DRAFT", invoiceUrl: null, freightQuote: false, backorder: false, balanceDueCents: 0, payBalanceUrl: null, tracking: [] }
          : statusMap.get(sheet.shopifyDraftOrderId ?? "") ??
            { key: "SUBMITTED", invoiceUrl: null, freightQuote: false, backorder: false, balanceDueCents: 0, payBalanceUrl: null, tracking: [] };

      // Enrich lines with current catalog info. Unit prices are today's
      // wholesale prices (null if the variant left the program) — the
      // sheet-level subtotal is the stored as-submitted amount, and the
      // Shopify invoice remains the financial source of truth.
      let nodes: any[] = [];
      if (lines.length > 0) {
        try {
          const res = await admin.graphql(
            `query OrderSheetVariants($ids: [ID!]!) {
              nodes(ids: $ids) {
                ... on ProductVariant {
                  id
                  title
                  sku
                  price
                  image { url }
                  product {
                    title
                    handle
                    status
                    featuredImage { url }
                    hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
                  }
                }
              }
            }`,
            { variables: { ids: lines.map((l) => `gid://shopify/ProductVariant/${l.variant_id}`) } }
          );
          const body = await res.json();
          nodes = (body.data?.nodes ?? []).filter(Boolean);
        } catch (err) {
          console.error("[app-proxy/orders] variant lookup failed:", err);
        }
      }
      const nodeById = new Map(nodes.map((n: any) => [String(n.id.split("/").pop()), n]));
      const cmsMap = await getCmsVariantMap(
        lines.map((l) => ({ id: l.variant_id, sku: nodeById.get(String(l.variant_id))?.sku }))
      );

      return proxyJson({
        wholesale: true,
        order: {
          id: sheet.id,
          order_name: sheet.orderName || "—",
          po_number: sheet.poNumber || "",
          ship_own_label: sheet.shipOwnLabel,
          submitted_at: sheet.updatedAt,
          subtotal_cents: sheet.subtotalCents,
          status: st.key,
          invoice_url: st.invoiceUrl,
          freight_quote: st.freightQuote,
          backorder: st.backorder,
          balance_due_cents: st.balanceDueCents,
          pay_balance_url: st.payBalanceUrl,
          tracking: st.tracking,
          draft_order_id: sheet.shopifyDraftOrderId,
          lines: lines.map((l) => {
            const node = nodeById.get(String(l.variant_id));
            let unitPriceCents: number | null = null;
            if (node) {
              const retailCents = Math.round(parseFloat(node.price) * 100);
              const state = resolveVariantWholesale({
                cms: cmsMap.get(String(l.variant_id)),
                variantId: String(l.variant_id),
                hiddenVariantIds: parseHiddenVariantIds(node.product?.hiddenVariants?.value),
                productActive: node.product?.status === "ACTIVE",
                customerType: session.customerType,
                retailCents,
              });
              if (state.available) unitPriceCents = state.priceCents;
            }
            return {
              variant_id: l.variant_id,
              quantity: l.quantity,
              product_title: node?.product?.title ?? `Item ${l.variant_id}`,
              variant_title: node && node.title !== "Default Title" ? node.title : "",
              sku: node?.sku ?? "",
              image_url: node?.image?.url ?? node?.product?.featuredImage?.url ?? null,
              unit_price_cents: unitPriceCents,
              product_url: node?.product?.handle
                ? `/products/${node.product.handle}?variant=${l.variant_id}`
                : null,
            };
          }),
        },
      });
    }

    const sheets = await db.linesheetDraft.findMany({
      where: { shopifyCustomerId: session.shopifyCustomerId, status: "SUBMITTED" },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    const statusMap = await fetchDraftOrderStatuses(
      admin,
      sheets.map((s) => s.shopifyDraftOrderId).filter((id): id is string => !!id)
    );

    // The active draft (if it has anything on it) leads the list: the Orders
    // page is where a draft is reviewed and submitted, and until submission
    // nothing exists in Shopify.
    const activeDraft = await getActiveDraft(session.shopifyCustomerId);
    const draftLines = activeDraft ? parseDraftLines(activeDraft.lines) : [];
    const draftRow =
      activeDraft && draftLines.length > 0
        ? [
            {
              id: activeDraft.id,
              // No Shopify order number exists yet for the working draft.
              order_name: "CURRENT DRAFT",
              po_number: activeDraft.poNumber || "",
              submitted_at: activeDraft.updatedAt,
              subtotal_cents: activeDraft.subtotalCents,
              line_count: draftLines.length,
              item_count: draftLines.reduce((n, l) => n + l.quantity, 0),
              status: "DRAFT",
              invoice_url: null,
              freight_quote: false,
              backorder: false,
              balance_due_cents: 0,
              pay_balance_url: null,
              tracking: [] as Array<never>,
              draft_order_id: null,
            },
          ]
        : [];

    return proxyJson({
      wholesale: true,
      orders: [
        ...draftRow,
        ...sheets.map((s) => {
          const lines = parseDraftLines(s.lines);
          const st =
            statusMap.get(s.shopifyDraftOrderId ?? "") ??
            { key: "SUBMITTED", invoiceUrl: null, freightQuote: false, backorder: false, balanceDueCents: 0, payBalanceUrl: null, tracking: [] };
          return {
            id: s.id,
            order_name: s.orderName || "—",
            po_number: s.poNumber || "",
            submitted_at: s.updatedAt,
            subtotal_cents: s.subtotalCents,
            line_count: lines.length,
            item_count: lines.reduce((n, l) => n + l.quantity, 0),
            status: st.key,
            invoice_url: st.invoiceUrl,
            freight_quote: st.freightQuote,
            backorder: st.backorder,
            balance_due_cents: st.balanceDueCents,
            pay_balance_url: st.payBalanceUrl,
            tracking: st.tracking,
            draft_order_id: s.shopifyDraftOrderId,
          };
        }),
      ],
    });
  }

  return json({ error: "Not found" }, { status: 404 });
};

// ── POST handler ─────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const subpath = (params["*"] ?? "").replace(/^\//, "");

  if (subpath === "linesheet-order") {
    return handleLinesheetOrder(request, url);
  }

  // ── /apps/wholesale/linesheet-draft (POST) ──────────────────────────────
  // Autosave the customer's active draft. Body: { lines, subtotal_cents }.
  if (subpath === "linesheet-draft") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const lines = sanitizeDraftLines(payload?.lines);
    const subtotalCents = Math.max(0, Math.floor(Number(payload?.subtotal_cents)) || 0);
    const poNumber = String(payload?.po_number ?? "").slice(0, 120);
    const shipOwnLabel = payload?.ship_own_label === true;

    // edit_of: autosave targets the EDITING session, never the working draft.
    const editOf = String(payload?.edit_of ?? "").replace(/\D/g, "");
    if (editOf) {
      const editRow = await db.linesheetDraft.findFirst({
        where: {
          shopifyCustomerId: session.shopifyCustomerId,
          status: "EDITING",
          shopifyDraftOrderId: editOf,
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!editRow) {
        return json({ error: "Edit session expired", edit_expired: true }, { status: 404 });
      }
      await db.linesheetDraft.update({
        where: { id: editRow.id },
        data: {
          lines: JSON.stringify(lines),
          subtotalCents,
          poNumber: poNumber || null,
          shipOwnLabel,
        },
      });
      return proxyJson({ ok: true, line_count: lines.length });
    }

    const saved = await upsertActiveDraft(session.shopifyCustomerId, lines, subtotalCents);
    await db.linesheetDraft.update({
      where: { id: saved.id },
      data: { poNumber: poNumber || null, shipOwnLabel },
    });
    return proxyJson({ ok: true, line_count: lines.length });
  }

  // ── /apps/wholesale/linesheet-edit-begin (POST) ─────────────────────────
  // Start editing an unpaid order: snapshot its SUBMITTED sheet into an
  // EDITING session row (one per customer, newest wins). The working draft
  // is not involved at any point.
  if (subpath === "linesheet-edit-begin") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const source = await db.linesheetDraft.findFirst({
      where: {
        id: String(payload?.draft_id ?? ""),
        shopifyCustomerId: session.shopifyCustomerId,
        status: "SUBMITTED",
      },
    });
    if (!source || !source.shopifyDraftOrderId) {
      return json({ error: "Order not found" }, { status: 404 });
    }
    await db.linesheetDraft.deleteMany({
      where: { shopifyCustomerId: session.shopifyCustomerId, status: "EDITING" },
    });
    await db.linesheetDraft.create({
      data: {
        shopifyCustomerId: session.shopifyCustomerId,
        status: "EDITING",
        lines: source.lines,
        subtotalCents: source.subtotalCents,
        poNumber: source.poNumber,
        shipOwnLabel: source.shipOwnLabel,
        shopifyDraftOrderId: source.shopifyDraftOrderId,
      },
    });
    return proxyJson({
      ok: true,
      draft_order_id: source.shopifyDraftOrderId,
      order_name: source.orderName || "",
    });
  }

  // ── /apps/wholesale/linesheet-edit-cancel (POST) ────────────────────────
  // Discard the edit session. The order and the working draft are untouched.
  if (subpath === "linesheet-edit-cancel") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });
    await db.linesheetDraft.deleteMany({
      where: { shopifyCustomerId: session.shopifyCustomerId, status: "EDITING" },
    });
    return proxyJson({ ok: true });
  }

  // ── /apps/wholesale/linesheet-duplicate (POST) ──────────────────────────
  // Copy a SUBMITTED sheet's lines into the customer's active draft.
  // Body: { draft_id }. Returns the lines so the client can prefill.
  if (subpath === "linesheet-duplicate") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return json({ wholesale: false }, { status: 403 });

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const source = await db.linesheetDraft.findFirst({
      where: {
        id: String(payload?.draft_id ?? ""),
        shopifyCustomerId: session.shopifyCustomerId,
        status: "SUBMITTED",
      },
    });
    if (!source) return json({ error: "Order sheet not found" }, { status: 404 });

    const lines = parseDraftLines(source.lines);
    // Reorder replaces the working draft with this order's items (edits use
    // /linesheet-edit-begin and never touch the draft).
    await upsertActiveDraft(session.shopifyCustomerId, lines, source.subtotalCents);
    return proxyJson({ ok: true, lines });
  }

  if (subpath !== "backorder") {
    return json({ error: "Not found" }, { status: 404 });
  }

  // Verify wholesale session — logged_in_customer_id is HMAC-signed in query params
  const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
  const wholesaleSession = await getWholesaleSession(shopifyCustomerId);
  if (!wholesaleSession) {
    return json({ wholesale: false }, { status: 403 });
  }

  // `shop` is in the HMAC-signed query params — safe to use after appProxy verification
  const shop = url.searchParams.get("shop");
  if (!shop) {
    return json({ error: "Missing shop param" }, { status: 400 });
  }

  const formData = await request.formData();
  const variantId = String(formData.get("variant_id") ?? "").trim();
  const quantity = Math.max(1, parseInt(String(formData.get("quantity") ?? "1"), 10) || 1);

  if (!variantId) {
    return json({ error: "variant_id is required" }, { status: 400 });
  }

  // Admin API client — loads the shop's offline session from Prisma storage.
  // This works because the app is installed on the shop (App Proxy only runs when installed).
  const { admin } = await unauthenticated.admin(shop);

  const variantGid = `gid://shopify/ProductVariant/${variantId}`;
  const customerGid = `gid://shopify/Customer/${wholesaleSession.shopifyCustomerId}`;

  // Validate wholesale availability and resolve the CMS price for this variant.
  // A variant outside the program cannot be backordered at wholesale terms.
  let variantData: any;
  try {
    const vRes = await admin.graphql(VARIANT_QUERY, { variables: { id: variantGid } });
    const vBody = await vRes.json();
    variantData = vBody.data?.productVariant;
  } catch (err) {
    console.error("[app-proxy/backorder] Variant lookup failed:", err);
    return json({ error: "Failed to look up variant" }, { status: 502 });
  }
  if (!variantData) {
    return json({ error: "Variant not found" }, { status: 404 });
  }

  const retailCents = Math.round(parseFloat(variantData.price) * 100);
  const cmsMap = await getCmsVariantMap([{ id: variantId, sku: variantData.sku }]);
  const state = resolveVariantWholesale({
    cms: cmsMap.get(String(variantId)),
    variantId,
    hiddenVariantIds: parseHiddenVariantIds(variantData.product?.hiddenVariants?.value),
    productActive: variantData.product?.status === "ACTIVE",
    customerType: wholesaleSession.customerType,
    retailCents,
  });
  if (!state.available) {
    return json({ error: "This item is not available for wholesale." }, { status: 403 });
  }
  if (!wholesaleSession.exemptFromMoq && quantity < state.moq) {
    return json(
      { error: `Minimum order quantity for this item is ${state.moq}.` },
      { status: 422 }
    );
  }

  // Draft orders price via a per-line discount off retail; derive the exact
  // percentage that lands on the CMS wholesale price.
  const effectiveDiscount =
    retailCents > 0
      ? Math.round((1 - state.priceCents / retailCents) * 10000) / 100
      : 0;

  const backorderShippingLine =
    !productHasNoFreeShippingTag(variantData.product) &&
    (await customerDefaultAddressIsUS(admin, customerGid))
      ? FREE_SHIPPING_LINE
      : null;

  let draftOrder: any;
  try {
    const draftRes = await admin.graphql(
      `#graphql
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name invoiceUrl }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            lineItems: [
              {
                variantId: variantGid,
                quantity,
                appliedDiscount: {
                  valueType: "PERCENTAGE",
                  value: effectiveDiscount,
                  title: `Wholesale ${effectiveDiscount}%`,
                },
              },
            ],
            customerId: customerGid,
            ...(backorderShippingLine ? { shippingLine: backorderShippingLine } : {}),
            tags: ["wholesale", "backorder"],
            note: "Wholesale backorder — will ship when stock is available.",
          },
        },
      }
    );

    const draftData = await draftRes.json();
    const errors = draftData.data?.draftOrderCreate?.userErrors ?? [];

    if (errors.length > 0) {
      console.error("[app-proxy/backorder] Draft order userErrors:", errors);
      return json({ error: "Failed to create backorder", details: errors }, { status: 500 });
    }

    draftOrder = draftData.data?.draftOrderCreate?.draftOrder;
  } catch (err) {
    console.error("[app-proxy/backorder] Admin API error:", err);
    return json({ error: "Failed to create backorder" }, { status: 502 });
  }

  if (!draftOrder) {
    return json({ error: "Draft order not returned" }, { status: 500 });
  }

  // Persist the backorder in our DB
  const draftOrderNumericId = draftOrder.id.split("/").pop() ?? "";
  await db.wholesaleOrder.create({
    data: {
      shopifyDraftOrderId: draftOrderNumericId,
      orderName: draftOrder.name,
      shopifyCustomerId: wholesaleSession.shopifyCustomerId,
      paymentTerms: wholesaleSession.paymentTerms,
      totalAmount: 0,  // updated when Draft Order is completed via webhook
      discountPercent: effectiveDiscount,
      isBackorder: true,
      orderTags: JSON.stringify(["wholesale", "backorder"]),
      status: "PENDING",
    },
  });

  return proxyJson({
    ok: true,
    order_name: draftOrder.name,
    invoice_url: draftOrder.invoiceUrl,
  });
};

// ── POST /apps/wholesale/linesheet-order ─────────────────────────────────────
// The wholesale ORDERING path: quantities from the line sheet become ONE
// draft order at exact CMS wholesale prices, attached to the customer (so
// Shopify's native taxExempt applies), tagged with the customer's payment
// terms. The theme cart is NOT used — it checks out at retail. Draft orders
// also don't reserve inventory, so out-of-stock lines are fine (backorders
// ride along in the same order).
// How long an unpaid invoice holds its stock (per Taylor: 24 hours). After
// the hold lapses the stock is sellable again; an untouched invoice can then
// hit the quantity-adjust failure at payment time, so staff should follow up
// or re-issue. Staff can extend a hold on the draft in Shopify Admin
// ("Reserve items").
const INVOICE_INVENTORY_RESERVE_HOURS = 24;

async function handleLinesheetOrder(request: Request, url: URL) {
  const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
  const wholesaleSession = await getWholesaleSession(shopifyCustomerId);
  if (!wholesaleSession) {
    return json({ wholesale: false }, { status: 403 });
  }

  const shop = url.searchParams.get("shop");
  if (!shop) return json({ error: "Missing shop param" }, { status: 400 });

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Submission comes from the Orders page review: { draft_id } points at the
  // customer's active DRAFT sheet and the server reads lines/PO/label from it.
  // { edit_of: draftOrderId } instead submits the EDITING session as an
  // in-place update of that existing unpaid order (draftOrderUpdate — same
  // order number, same invoice URL; the working draft is never involved).
  // A body with explicit `lines` is still honored (legacy path).
  let rawLines: Array<{ variant_id: unknown; quantity: unknown }> = Array.isArray(payload?.lines)
    ? payload.lines
    : [];
  let poNumber = String(payload?.po_number ?? "").slice(0, 120).trim();
  let shipOwnLabel = payload?.ship_own_label === true;

  const editOfDraftOrderId = String(payload?.edit_of ?? "").replace(/\D/g, "");

  if (editOfDraftOrderId && rawLines.length === 0) {
    const editSheet = await db.linesheetDraft.findFirst({
      where: {
        shopifyCustomerId: wholesaleSession.shopifyCustomerId,
        status: "EDITING",
        shopifyDraftOrderId: editOfDraftOrderId,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!editSheet) {
      return json(
        { error: "This edit session has expired — reopen the order from Order History.", edit_expired: true },
        { status: 404 }
      );
    }
    rawLines = parseDraftLines(editSheet.lines) as Array<{ variant_id: unknown; quantity: unknown }>;
    poNumber = (editSheet.poNumber ?? "").slice(0, 120).trim();
    shipOwnLabel = editSheet.shipOwnLabel;
  } else if (payload?.draft_id && rawLines.length === 0) {
    const draftSheet = await db.linesheetDraft.findFirst({
      where: {
        id: String(payload.draft_id),
        shopifyCustomerId: wholesaleSession.shopifyCustomerId,
        status: "DRAFT",
      },
    });
    if (!draftSheet) {
      return json({ error: "Draft not found — it may already be submitted. Refresh the page." }, { status: 404 });
    }
    rawLines = parseDraftLines(draftSheet.lines) as Array<{ variant_id: unknown; quantity: unknown }>;
    poNumber = (draftSheet.poNumber ?? "").slice(0, 120).trim();
    shipOwnLabel = draftSheet.shipOwnLabel;
  }

  const lines = rawLines
    .map((l) => ({
      variantId: String(l.variant_id ?? "").replace(/\D/g, ""),
      quantity: Math.floor(Number(l.quantity)),
    }))
    .filter((l) => l.variantId && Number.isFinite(l.quantity) && l.quantity > 0);

  if (lines.length === 0) {
    return json({ error: "No items selected." }, { status: 422 });
  }
  if (lines.length > 250) {
    return json({ error: "Too many line items (max 250)." }, { status: 422 });
  }

  const { admin } = await unauthenticated.admin(shop);

  // Editing an order: validate the target BEFORE touching anything. A still-
  // open draft is updated in place (draftOrderUpdate); a COMPLETED draft
  // whose real order is unshipped goes through the Order Edit API instead
  // (additions only — see the order-edit branch). Shipped/cancelled = no.
  let editTarget: {
    rowId: string;
    gid: string;
    name: string;
    orderGid: string | null;
    // Variant → quantity already on the order being edited. Those units are
    // reserved/sold to THIS order, so stock checks credit them back —
    // otherwise a customer who bought the last units sees their own order
    // flagged as backorder when they reopen it to edit.
    prevQty: Map<string, number>;
  } | null = null;
  if (editOfDraftOrderId) {
    const row = await db.wholesaleOrder.findFirst({
      where: {
        shopifyDraftOrderId: editOfDraftOrderId,
        shopifyCustomerId: wholesaleSession.shopifyCustomerId,
      },
    });
    if (!row) {
      return json(
        { error: "The order you were editing can't be found.", edit_expired: true },
        { status: 422 }
      );
    }
    const gid = `gid://shopify/DraftOrder/${editOfDraftOrderId}`;
    try {
      const res = await admin.graphql(
        `query EditTargetStatus($id: ID!) {
          draftOrder(id: $id) {
            id
            name
            status
            lineItems(first: 250) { nodes { quantity variant { legacyResourceId } } }
            order {
              id
              cancelledAt
              displayFulfillmentStatus
              lineItems(first: 250) { nodes { quantity variant { legacyResourceId } } }
            }
          }
        }`,
        { variables: { id: gid } }
      );
      const body = await res.json();
      const target = body.data?.draftOrder;
      if (!target) {
        return json(
          { error: "The order you were editing can't be found.", edit_expired: true },
          { status: 422 }
        );
      }
      const prevQtyFrom = (nodes: any[]): Map<string, number> => {
        const m = new Map<string, number>();
        for (const n of nodes ?? []) {
          const id = n?.variant?.legacyResourceId ? String(n.variant.legacyResourceId) : null;
          if (id) m.set(id, (m.get(id) ?? 0) + (n.quantity ?? 0));
        }
        return m;
      };
      if (target.status === "COMPLETED") {
        const order = target.order;
        if (!order || order.cancelledAt || order.displayFulfillmentStatus === "FULFILLED") {
          return json(
            {
              error: `Order ${target.name} has ${order?.cancelledAt ? "been cancelled" : "already shipped"} and can no longer be edited.`,
              edit_expired: true,
            },
            { status: 422 }
          );
        }
        editTarget = {
          rowId: row.id,
          gid,
          name: target.name,
          orderGid: order.id,
          prevQty: prevQtyFrom(order.lineItems?.nodes),
        };
      } else {
        editTarget = {
          rowId: row.id,
          gid,
          name: target.name,
          orderGid: null,
          prevQty: prevQtyFrom(target.lineItems?.nodes),
        };
      }
    } catch (err) {
      console.error("[app-proxy/linesheet-order] edit-target lookup failed:", err);
      return json({ error: "Could not verify the order being edited — please try again." }, { status: 502 });
    }
  }

  // Batch-validate every variant: availability, CMS price, MOQ.
  let nodes: any[] = [];
  try {
    const res = await admin.graphql(
      `query LinesheetOrderVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            title
            price
            availableForSale
            inventoryQuantity
            product {
              id
              title
              status
              tags
              hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
            }
          }
        }
      }`,
      { variables: { ids: lines.map((l) => `gid://shopify/ProductVariant/${l.variantId}`) } }
    );
    const body = await res.json();
    nodes = body.data?.nodes ?? [];
  } catch (err) {
    console.error("[app-proxy/linesheet-order] variant lookup failed:", err);
    return json({ error: "Failed to validate items" }, { status: 502 });
  }

  const nodeById = new Map(
    nodes.filter(Boolean).map((n: any) => [String(n.id.split("/").pop()), n])
  );
  const cmsMap = await getCmsVariantMap(
    lines.map((l) => ({ id: l.variantId, sku: nodeById.get(l.variantId)?.sku }))
  );

  const problems: string[] = [];
  const lineItems: any[] = [];
  let subtotalCents = 0;
  let retailSubtotalCents = 0;

  for (const line of lines) {
    const node = nodeById.get(line.variantId);
    if (!node) {
      problems.push(`Unknown item (${line.variantId}).`);
      continue;
    }
    const label = node.sku || node.product.title;
    const retailCents = Math.round(parseFloat(node.price) * 100);
    const state = resolveVariantWholesale({
      cms: cmsMap.get(line.variantId),
      variantId: line.variantId,
      hiddenVariantIds: parseHiddenVariantIds(node.product?.hiddenVariants?.value),
      productActive: node.product?.status === "ACTIVE",
      customerType: wholesaleSession.customerType,
      retailCents,
    });
    if (!state.available) {
      problems.push(`${label} is not available for wholesale.`);
      continue;
    }
    if (!wholesaleSession.exemptFromMoq && line.quantity < state.moq) {
      problems.push(`${label}: minimum order quantity is ${state.moq}.`);
      continue;
    }

    subtotalCents += state.priceCents * line.quantity;
    retailSubtotalCents += retailCents * line.quantity;
    const discountPct =
      retailCents > 0
        ? Math.round((1 - state.priceCents / retailCents) * 10000) / 100
        : 0;
    // Out-of-stock lines split into a SEPARATE backorder draft order —
    // Shopify's invoice checkout strips deny-policy OOS lines at payment
    // time, so they can't ride in the payable order.
    //
    // Edit mode: quantities already on the order being edited are reserved
    // FOR that order (the invoice reservation/sale consumed the stock), so
    // they're credited back — a line is only short if it asks for more than
    // live stock + its own reservation.
    const reservedCredit = editTarget?.prevQty.get(line.variantId) ?? 0;
    const effectiveStock = (node.inventoryQuantity ?? 0) + reservedCredit;
    const isBackorder = editTarget
      ? line.quantity > effectiveStock
      : !node.availableForSale || (node.inventoryQuantity ?? 0) <= 0;
    lineItems.push({
      isBackorder,
      effectiveStock,
      requested: line.quantity,
      label,
      noFreeShipping: productHasNoFreeShippingTag(node.product),
      amountCents: state.priceCents * line.quantity,
      input: {
        variantId: node.id,
        quantity: line.quantity,
        appliedDiscount: {
          valueType: "PERCENTAGE",
          value: discountPct,
          title: "Wholesale",
        },
        ...(isBackorder
          ? { customAttributes: [{ key: "Backorder", value: "ships when back in stock" }] }
          : {}),
      },
    });
  }

  if (problems.length > 0) {
    return json({ error: problems.join(" ") }, { status: 422 });
  }

  // Order minimum: enforced server-side against the wholesale subtotal.
  const minimums = await getEffectiveOrderMinimum(wholesaleSession.shopifyCustomerId);
  if (subtotalCents < Math.round(minimums.minimumOrderValue * 100)) {
    return json(
      {
        error: `Order minimum is $${minimums.minimumOrderValue.toFixed(2)} — this order totals $${(subtotalCents / 100).toFixed(2)}.`,
        minimum_cents: Math.round(minimums.minimumOrderValue * 100),
        subtotal_cents: subtotalCents,
      },
      { status: 422 }
    );
  }

  const termsTag =
    wholesaleSession.paymentTerms === "NET_30"
      ? "net-30"
      : wholesaleSession.paymentTerms === "NET_60"
        ? "net-60"
        : null;

  // NET-terms customers get REAL Shopify payment terms on the order (native
  // due-date tracking, overdue badges, and payment reminders) — resolve the
  // matching template. Best-effort: order creation proceeds without terms if
  // the lookup fails.
  let paymentTermsTemplateId: string | null = null;
  if (termsTag) {
    try {
      const res = await admin.graphql(`query { paymentTermsTemplates { id name } }`);
      const body = await res.json();
      const wantName = wholesaleSession.paymentTerms === "NET_30" ? "Net 30" : "Net 60";
      paymentTermsTemplateId =
        (body.data?.paymentTermsTemplates ?? []).find((t: any) => t.name === wantName)?.id ??
        null;
    } catch (err) {
      console.error("[app-proxy/linesheet-order] payment terms lookup failed:", err);
    }
  }

  const stockItems = lineItems.filter((l) => !l.isBackorder);
  const backorderItems = lineItems.filter((l) => l.isBackorder);

  const noteLines = [
    poNumber ? `PO: ${poNumber}` : null,
    shipOwnLabel
      ? "Customer provides own shipping label — send carton dimensions when packed."
      : null,
  ];

  const sess = wholesaleSession; // non-null capture for the closure below

  // Shipping is resolved per draft (stock and backorder split orders each get
  // their own): own-label always wins, a heavy item in the draft means staff
  // price real freight, otherwise US customers get the free line.
  const customerIsUS = await customerDefaultAddressIsUS(
    admin,
    `gid://shopify/Customer/${sess.shopifyCustomerId}`
  );
  function shippingLineFor(items: typeof lineItems) {
    if (shipOwnLabel) return OWN_LABEL_SHIPPING_LINE;
    if (items.some((l) => l.noFreeShipping)) return null;
    return customerIsUS ? FREE_SHIPPING_LINE : null;
  }

  // ── In-place edit of an existing unpaid order ──────────────────────────────
  // draftOrderUpdate replaces the line set on the SAME draft order: same
  // order number, same invoice URL — nothing is duplicated or deleted.
  if (editTarget) {
    // Out-of-stock lines can't ride in a payable invoice (Shopify strips
    // deny-policy OOS lines at payment) and an edit has no backorder split.
    // effectiveStock already credits units the order itself holds, so this
    // only fires for genuinely unavailable quantities.
    const oos = lineItems.filter((l) => l.isBackorder);
    if (oos.length > 0) {
      return json(
        {
          error:
            "Not enough stock to update the order: " +
            oos
              .map((l) => `${l.label} (${Math.max(0, l.effectiveStock)} available, ${l.requested} requested)`)
              .join(", ") +
            ". Reduce those quantities, or order the extra units on a new sheet — they'll ship as a backorder.",
        },
        { status: 422 }
      );
    }

    // ── Paid/queued order: additions & increases only, via the Order Edit
    // API (same machinery as Admin's "Edit order"). Removals/decreases mean
    // refunds — human territory. Committing leaves an outstanding balance
    // the customer pays via PAY BALANCE on the Orders page.
    if (editTarget.orderGid) {
      let calcId: string | null = null;
      const currentByVariant = new Map<string, { id: string; quantity: number }>();
      try {
        const res = await admin.graphql(
          `#graphql
          mutation BeginOrderEdit($id: ID!) {
            orderEditBegin(id: $id) {
              calculatedOrder {
                id
                lineItems(first: 250) {
                  nodes { id quantity variant { id } }
                }
              }
              userErrors { field message }
            }
          }`,
          { variables: { id: editTarget.orderGid } }
        );
        const body = await res.json();
        const errors = body.data?.orderEditBegin?.userErrors ?? [];
        if (errors.length > 0) throw new Error(JSON.stringify(errors));
        const calc = body.data?.orderEditBegin?.calculatedOrder;
        calcId = calc?.id ?? null;
        for (const n of calc?.lineItems?.nodes ?? []) {
          const variantNum = n.variant?.id ? String(n.variant.id.split("/").pop()) : null;
          if (variantNum) currentByVariant.set(variantNum, { id: n.id, quantity: n.quantity });
        }
      } catch (err) {
        console.error("[app-proxy/linesheet-order] orderEditBegin failed:", err);
      }
      if (!calcId) {
        return json({ error: "Could not open the order for editing — please try again." }, { status: 502 });
      }

      // Diff desired lines against the order's current lines.
      const decreases: string[] = [];
      const additions: Array<(typeof lineItems)[number]> = [];
      const increases: Array<{ calcLineId: string; qty: number; item: (typeof lineItems)[number] }> = [];
      const desiredVariants = new Set<string>();
      for (const l of lineItems) {
        const variantNum = String(l.input.variantId).split("/").pop()!;
        desiredVariants.add(variantNum);
        const cur = currentByVariant.get(variantNum);
        if (!cur) additions.push(l);
        else if (l.input.quantity > cur.quantity) {
          increases.push({ calcLineId: cur.id, qty: l.input.quantity, item: l });
        } else if (l.input.quantity < cur.quantity) decreases.push(l.label);
      }
      const removedCount = [...currentByVariant.keys()].filter(
        (v) => !desiredVariants.has(v)
      ).length;
      if (decreases.length > 0 || removedCount > 0) {
        return json(
          {
            error:
              "Items can't be removed or reduced on an order that's already been paid — " +
              "add items freely, but for reductions contact us and we'll sort out the refund.",
          },
          { status: 422 }
        );
      }
      if (additions.length === 0 && increases.length === 0) {
        return json({ error: "No changes to submit — quantities match the order." }, { status: 422 });
      }
      // An order edit can't change shipping, so freight-priced items (which
      // need a shipping re-quote) stay off paid orders.
      const freightChanged = [...additions, ...increases.map((i) => i.item)].filter(
        (l) => l.noFreeShipping
      );
      if (freightChanged.length > 0) {
        return json(
          {
            error:
              "Freight-priced items can't be added to a paid order (shipping must be quoted): " +
              freightChanged.map((l) => l.label).join(", ") +
              ". Order them on a new sheet instead.",
          },
          { status: 422 }
        );
      }

      // Apply the changes; nothing touches the real order until commit.
      try {
        for (const inc of increases) {
          const res = await admin.graphql(
            `#graphql
            mutation EditSetQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
              orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
                calculatedOrder { id }
                userErrors { field message }
              }
            }`,
            { variables: { id: calcId, lineItemId: inc.calcLineId, quantity: inc.qty } }
          );
          const body = await res.json();
          const errs = body.data?.orderEditSetQuantity?.userErrors ?? [];
          if (errs.length > 0) throw new Error(JSON.stringify(errs));
        }
        for (const add of additions) {
          const res = await admin.graphql(
            `#graphql
            mutation EditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
              orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: false) {
                calculatedLineItem { id }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                id: calcId,
                variantId: add.input.variantId,
                quantity: add.input.quantity,
              },
            }
          );
          const body = await res.json();
          const errs = body.data?.orderEditAddVariant?.userErrors ?? [];
          if (errs.length > 0) throw new Error(JSON.stringify(errs));
          const newLineId = body.data?.orderEditAddVariant?.calculatedLineItem?.id;
          const pct = add.input.appliedDiscount?.value ?? 0;
          if (newLineId && pct > 0) {
            const dres = await admin.graphql(
              `#graphql
              mutation EditAddDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
                orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                  calculatedOrder { id }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  id: calcId,
                  lineItemId: newLineId,
                  discount: { percentValue: pct, description: "Wholesale" },
                },
              }
            );
            const dbody = await dres.json();
            const derrs = dbody.data?.orderEditAddLineItemDiscount?.userErrors ?? [];
            if (derrs.length > 0) throw new Error(JSON.stringify(derrs));
          }
        }
        const cres = await admin.graphql(
          `#graphql
          mutation CommitOrderEdit($id: ID!) {
            orderEditCommit(id: $id, notifyCustomer: true, staffNote: "Customer added items via the wholesale line sheet.") {
              order { id name }
              userErrors { field message }
            }
          }`,
          { variables: { id: calcId } }
        );
        const cbody = await cres.json();
        const cerrs = cbody.data?.orderEditCommit?.userErrors ?? [];
        if (cerrs.length > 0) throw new Error(JSON.stringify(cerrs));
      } catch (err) {
        console.error("[app-proxy/linesheet-order] order edit failed:", err);
        return json(
          { error: "Could not update the order — no changes were applied. Please try again or contact us." },
          { status: 502 }
        );
      }

      // Sync our records; the edit session is finished.
      await db.wholesaleOrder.update({
        where: { id: editTarget.rowId },
        data: {
          totalAmount: subtotalCents,
          discountPercent:
            retailSubtotalCents > 0
              ? Math.round((1 - subtotalCents / retailSubtotalCents) * 100)
              : 0,
        },
      });
      await db.linesheetDraft.updateMany({
        where: {
          shopifyCustomerId: wholesaleSession.shopifyCustomerId,
          status: "SUBMITTED",
          shopifyDraftOrderId: editOfDraftOrderId,
        },
        data: {
          lines: JSON.stringify(
            lines.map((l) => ({ variant_id: Number(l.variantId), quantity: l.quantity }))
          ),
          subtotalCents,
        },
      });
      await db.linesheetDraft.deleteMany({
        where: { shopifyCustomerId: wholesaleSession.shopifyCustomerId, status: "EDITING" },
      });

      // Fresh balance for the response (best effort — the Orders page derives
      // it independently either way).
      let balanceDueCents = 0;
      let payBalanceUrl: string | null = null;
      try {
        const bres = await admin.graphql(
          `query OrderBalance($id: ID!) {
            order(id: $id) {
              totalOutstandingSet { shopMoney { amount } }
              paymentCollectionDetails { additionalPaymentCollectionUrl }
            }
          }`,
          { variables: { id: editTarget.orderGid } }
        );
        const bbody = await bres.json();
        const o = bbody.data?.order;
        balanceDueCents = Math.round(
          parseFloat(o?.totalOutstandingSet?.shopMoney?.amount ?? "0") * 100
        );
        payBalanceUrl =
          balanceDueCents > 0
            ? o?.paymentCollectionDetails?.additionalPaymentCollectionUrl ?? null
            : null;
      } catch (err) {
        console.error("[app-proxy/linesheet-order] balance lookup failed:", err);
      }

      return proxyJson({
        ok: true,
        edited: true,
        order_edit: true,
        order_name: editTarget.name,
        subtotal_cents: subtotalCents,
        balance_due_cents: balanceDueCents,
        pay_balance_url: payBalanceUrl,
        item_count: lineItems.length,
        payment_terms: wholesaleSession.paymentTerms,
      });
    }

    // Mirrors createDraft's input for a payable stock order.
    const needsFreightQuote = !shipOwnLabel && lineItems.some((l) => l.noFreeShipping);
    const tags = [
      "wholesale",
      "linesheet",
      ...(termsTag ? [termsTag] : []),
      ...(shipOwnLabel ? ["customer-shipping-label"] : []),
      ...(needsFreightQuote ? ["freight-quote"] : []),
    ];
    const shippingLine = shippingLineFor(lineItems);
    const input = {
      lineItems: lineItems.map((l) => l.input),
      ...(shippingLine ? { shippingLine } : {}),
      reserveInventoryUntil: new Date(
        Date.now() + INVOICE_INVENTORY_RESERVE_HOURS * 60 * 60 * 1000
      ).toISOString(),
      tags,
      note: [
        `Wholesale line sheet order${termsTag ? ` — payment terms ${termsTag.toUpperCase()}` : ""}.`,
        `Edited by customer ${new Date().toISOString().slice(0, 10)}.`,
        needsFreightQuote
          ? "Contains freight-priced items — set the shipping cost on this draft before sending the invoice."
          : null,
        ...noteLines,
      ]
        .filter(Boolean)
        .join("\n"),
      ...(poNumber ? { poNumber } : {}),
    };

    let updated: any = null;
    try {
      const res = await admin.graphql(
        `#graphql
        mutation linesheetDraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder { id name invoiceUrl }
            userErrors { field message }
          }
        }`,
        { variables: { id: editTarget.gid, input } }
      );
      const body = await res.json();
      const errors = body.data?.draftOrderUpdate?.userErrors ?? [];
      if (errors.length > 0) {
        console.error("[app-proxy/linesheet-order] draftOrderUpdate userErrors:", errors);
        const completed = errors.some((e: any) => /complet|paid/i.test(e.message ?? ""));
        return json(
          completed
            ? {
                error: `Order ${editTarget.name} has already been paid and can no longer be edited.`,
                edit_expired: true,
              }
            : { error: "Could not update the order — please try again." },
          { status: completed ? 422 : 502 }
        );
      }
      updated = body.data?.draftOrderUpdate?.draftOrder ?? null;
    } catch (err) {
      console.error("[app-proxy/linesheet-order] draftOrderUpdate failed:", err);
    }
    if (!updated) {
      return json({ error: "Could not update the order — please try again." }, { status: 502 });
    }

    // Sync our records to the new contents; the edit session is finished.
    await db.wholesaleOrder.update({
      where: { id: editTarget.rowId },
      data: {
        totalAmount: subtotalCents,
        discountPercent:
          retailSubtotalCents > 0
            ? Math.round((1 - subtotalCents / retailSubtotalCents) * 100)
            : 0,
        orderTags: JSON.stringify(tags),
      },
    });
    await db.linesheetDraft.updateMany({
      where: {
        shopifyCustomerId: wholesaleSession.shopifyCustomerId,
        status: "SUBMITTED",
        shopifyDraftOrderId: editOfDraftOrderId,
      },
      data: {
        lines: JSON.stringify(
          lines.map((l) => ({ variant_id: Number(l.variantId), quantity: l.quantity }))
        ),
        subtotalCents,
        poNumber: poNumber || null,
        shipOwnLabel,
      },
    });
    await db.linesheetDraft.deleteMany({
      where: { shopifyCustomerId: wholesaleSession.shopifyCustomerId, status: "EDITING" },
    });

    return proxyJson({
      ok: true,
      edited: true,
      order_name: updated.name,
      invoice_url: needsFreightQuote ? null : updated.invoiceUrl ?? null,
      freight_quote: needsFreightQuote,
      subtotal_cents: subtotalCents,
      item_count: lineItems.length,
      payment_terms: wholesaleSession.paymentTerms,
    });
  }

  async function createDraft(items: typeof lineItems, isBackorderOrder: boolean) {
    // Freight items suppress the free-shipping line (see shippingLineFor);
    // flag the draft so staff price real freight before sending the invoice.
    const needsFreightQuote = !shipOwnLabel && items.some((l) => l.noFreeShipping);
    const tags = [
      "wholesale",
      "linesheet",
      ...(isBackorderOrder ? ["backorder"] : []),
      ...(termsTag ? [termsTag] : []),
      ...(shipOwnLabel ? ["customer-shipping-label"] : []),
      ...(needsFreightQuote ? ["freight-quote"] : []),
    ];
    const shippingLine = shippingLineFor(items);
    const baseInput = {
      lineItems: items.map((l) => l.input),
      customerId: `gid://shopify/Customer/${sess.shopifyCustomerId}`,
      ...(shippingLine ? { shippingLine } : {}),
      // Reserve stock for the payable order: Shopify re-checks deny-policy
      // inventory when the customer pays the invoice, and if stock dipped
      // below the ordered qty in the meantime the checkout strips/adjusts
      // lines and strands the customer on an empty cart. Reserving holds the
      // units for the payment window. (Meaningless for the backorder draft —
      // those lines are out of stock by definition.)
      ...(!isBackorderOrder
        ? {
            reserveInventoryUntil: new Date(
              Date.now() + INVOICE_INVENTORY_RESERVE_HOURS * 60 * 60 * 1000
            ).toISOString(),
          }
        : {}),
      tags,
      note: [
        isBackorderOrder
          ? "Wholesale BACKORDER — do not invoice until stock arrives, then send the invoice from this draft."
          : `Wholesale line sheet order${termsTag ? ` — payment terms ${termsTag.toUpperCase()}` : ""}.`,
        needsFreightQuote
          ? "Contains freight-priced items — set the shipping cost on this draft before sending the invoice."
          : null,
        ...noteLines,
      ]
        .filter(Boolean)
        .join("\n"),
      ...(poNumber ? { poNumber } : {}),
    };
    // Payment terms only on the payable order — the backorder draft is
    // invoiced manually when stock arrives.
    const withTerms = !isBackorderOrder && paymentTermsTemplateId;

    async function attempt(input: Record<string, unknown>) {
      const res = await admin.graphql(
        `#graphql
        mutation linesheetDraftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id name invoiceUrl totalPrice }
            userErrors { field message }
          }
        }`,
        { variables: { input } }
      );
      const body = await res.json();
      return {
        errors: body.data?.draftOrderCreate?.userErrors ?? [],
        draftOrder: body.data?.draftOrderCreate?.draftOrder ?? null,
      };
    }

    let { errors, draftOrder } = await attempt(
      withTerms ? { ...baseInput, paymentTerms: { paymentTermsTemplateId } } : baseInput
    );
    // Payment terms are a nicety — never let them block the order (e.g. the
    // write_payment_terms scope not granted yet on this store).
    if (
      errors.length > 0 &&
      withTerms &&
      errors.some((e: any) => /payment terms/i.test(e.message ?? ""))
    ) {
      console.error("[app-proxy/linesheet-order] payment terms rejected, retrying without:", errors);
      ({ errors, draftOrder } = await attempt(baseInput));
    }
    if (errors.length > 0) {
      console.error("[app-proxy/linesheet-order] userErrors:", errors);
      return null;
    }
    if (!draftOrder) return null;

    const amount = items.reduce((sum, l) => sum + l.amountCents, 0);
    await db.wholesaleOrder.create({
      data: {
        shopifyDraftOrderId: draftOrder.id.split("/").pop() ?? "",
        orderName: draftOrder.name,
        shopifyCustomerId: sess.shopifyCustomerId,
        paymentTerms: sess.paymentTerms,
        totalAmount: amount,
        discountPercent:
          retailSubtotalCents > 0
            ? Math.round((1 - subtotalCents / retailSubtotalCents) * 100)
            : 0,
        isBackorder: isBackorderOrder,
        backorderNote: isBackorderOrder ? "Split from linesheet order — invoice when stock arrives." : null,
        orderTags: JSON.stringify(tags),
        status: "PENDING",
      },
    });
    return draftOrder;
  }

  let stockOrder: any = null;
  let backorderOrder: any = null;
  try {
    if (stockItems.length > 0) stockOrder = await createDraft(stockItems, false);
    if (backorderItems.length > 0) backorderOrder = await createDraft(backorderItems, true);
  } catch (err) {
    console.error("[app-proxy/linesheet-order] draftOrderCreate failed:", err);
    return json({ error: "Failed to create order" }, { status: 502 });
  }
  if (stockItems.length > 0 && !stockOrder) {
    return json({ error: "Failed to create order" }, { status: 500 });
  }
  if (backorderItems.length > 0 && !backorderOrder && stockItems.length === 0) {
    return json({ error: "Failed to create order" }, { status: 500 });
  }

  // NET-terms customers never pay upfront, so their draft would sit invisible
  // in Drafts — complete it immediately (payment pending) so it lands in the
  // orders/shipping queue with its due date tracked by the payment terms.
  // Best-effort: on failure it stays a draft and the staff draft-order alert
  // (Shopify Flow) catches it.
  let queuedOrder: { id: string; name: string } | null = null;
  if (stockOrder && termsTag) {
    try {
      const res = await admin.graphql(
        `#graphql
        mutation linesheetTermsComplete($id: ID!) {
          draftOrderComplete(id: $id, paymentPending: true) {
            draftOrder { order { id name } }
            userErrors { field message }
          }
        }`,
        { variables: { id: stockOrder.id } }
      );
      const body = await res.json();
      const errors = body.data?.draftOrderComplete?.userErrors ?? [];
      if (errors.length > 0) {
        console.error("[app-proxy/linesheet-order] terms auto-complete userErrors:", errors);
      } else {
        queuedOrder = body.data?.draftOrderComplete?.draftOrder?.order ?? null;
      }
    } catch (err) {
      console.error("[app-proxy/linesheet-order] terms auto-complete failed:", err);
    }
  }

  // Primary order for history/response: the payable one, else the backorder.
  const draftOrder = stockOrder ?? backorderOrder;

  // Flip the customer's active draft into SUBMITTED history (or record one if
  // they ordered without an autosaved draft) so it can be duplicated later.
  const submittedData = {
    lines: JSON.stringify(lines.map((l) => ({ variant_id: Number(l.variantId), quantity: l.quantity }))),
    subtotalCents,
    poNumber: poNumber || null,
    shipOwnLabel,
    status: "SUBMITTED",
    shopifyDraftOrderId: draftOrder.id.split("/").pop() ?? "",
    orderName:
      stockOrder && backorderOrder
        ? `${(queuedOrder ?? stockOrder).name} + ${backorderOrder.name} (backorder)`
        : (queuedOrder ?? draftOrder).name,
  };
  const activeDraft = await getActiveDraft(wholesaleSession.shopifyCustomerId);
  if (activeDraft) {
    await db.linesheetDraft.update({ where: { id: activeDraft.id }, data: submittedData });
  } else {
    await db.linesheetDraft.create({
      data: { shopifyCustomerId: wholesaleSession.shopifyCustomerId, ...submittedData },
    });
  }


  const stockFreight = !shipOwnLabel && stockItems.some((l) => l.noFreeShipping);
  return proxyJson({
    ok: true,
    order_name: queuedOrder ? queuedOrder.name : draftOrder.name,
    // Pay-now link only exists for the in-stock order; NET-terms orders are
    // auto-completed (invoiced per terms), an all-backorder submission is
    // invoiced by the merchant when stock arrives, and freight orders are
    // invoiced after staff quote shipping (instant pay would let the store's
    // retail rate table price the freight).
    invoice_url: stockOrder && !queuedOrder && !stockFreight ? stockOrder.invoiceUrl : null,
    freight_quote: stockFreight,
    order_queued: !!queuedOrder,
    subtotal_cents: subtotalCents,
    item_count: lineItems.length,
    payment_terms: wholesaleSession.paymentTerms,
    backorder_name: backorderOrder ? backorderOrder.name : null,
    backorder_count: backorderItems.length,
    all_backorder: !stockOrder && !!backorderOrder,
  });
}
