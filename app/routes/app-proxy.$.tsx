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
          collections(first: 1) {
            nodes { title handle }
          }
          variants(first: 100) {
            nodes {
              id
              title
              sku
              availableForSale
              inventoryQuantity
              price
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

// Admin API query — fetches variant prices for a batch of products by handle.
// Used by the catalog-card price labels (collection / search / home pages).
const CATALOG_QUERY = `
  query GetCatalogProducts($q: String!, $first: Int!) {
    shop { currencyCode }
    products(first: $first, query: $q) {
      nodes {
        id
        handle
        status
        hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
        variants(first: 100) {
          nodes { id sku price availableForSale }
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
        hiddenVariants: metafield(namespace: "custom", key: "wholesale_hidden_variants") { value }
      }
    }
  }
`;

function notWholesale() {
  return json(
    { wholesale: false },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}

function proxyJson(data: unknown) {
  return json(data, { headers: { "Cache-Control": "no-store" } });
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

  // ── /apps/wholesale/catalog-prices ──────────────────────────────────────
  // Batch wholesale "from" prices for product cards on collection/search/home
  // pages. Input: ?handles=a,b,c (comma-separated, capped at 50). Returns the
  // min wholesale price per product so the storefront can show "Wholesale $X"
  // beside the retail price on each card. CMS-aware with flat-discount fallback.
  if (subpath === "catalog-prices") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return notWholesale();

    const handles = (url.searchParams.get("handles") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (handles.length === 0) return proxyJson({ wholesale: true, products: {} });

    const shop = url.searchParams.get("shop");
    if (!shop) return json({ error: "Missing shop param" }, { status: 400 });

    // Shopify product query syntax: handle:a OR handle:b ...
    const q = handles.map((h) => `handle:${h}`).join(" OR ");

    let nodes: any[] = [];
    let shopCurrency = "USD";
    try {
      const { admin } = await unauthenticated.admin(shop);
      const result = await admin.graphql(CATALOG_QUERY, {
        variables: { q, first: handles.length },
      });
      const body = await result.json();
      nodes = body.data?.products?.nodes ?? [];
      shopCurrency = body.data?.shop?.currencyCode ?? "USD";
    } catch (err) {
      console.error("[app-proxy/catalog-prices] Admin API error:", err);
      return json({ error: "Failed to fetch catalog prices" }, { status: 502 });
    }

    const allVariantIds = nodes.flatMap((p: any) =>
      p.variants.nodes.map((v: any) => ({
        id: parseInt(v.id.split("/").pop(), 10),
        sku: v.sku,
      }))
    );
    const cmsMap = await getCmsVariantMap(allVariantIds);

    // Only wholesale-available variants contribute; products with none are
    // omitted from the response and get no card label (retail-only).
    const products: Record<string, any> = {};
    for (const p of nodes) {
      const hiddenIds = parseHiddenVariantIds(p.hiddenVariants?.value);
      const productActive = p.status === "ACTIVE";
      let whMin = Infinity;
      let whMax = -Infinity;
      let retailMin = Infinity;
      for (const v of p.variants.nodes) {
        const variantId = String(v.id.split("/").pop());
        const retailCents = Math.round(parseFloat(v.price) * 100);
        const state = resolveVariantWholesale({
          cms: cmsMap.get(variantId),
          variantId,
          hiddenVariantIds: hiddenIds,
          productActive,
          customerType: session.customerType,
          retailCents,
        });
        if (!state.available) continue;
        if (state.priceCents < whMin) whMin = state.priceCents;
        if (state.priceCents > whMax) whMax = state.priceCents;
        if (retailCents < retailMin) retailMin = retailCents;
      }
      if (whMin === Infinity) continue;
      products[p.handle] = {
        wh_min: whMin,
        wh_max: whMax,
        retail_min: retailMin === Infinity ? null : retailMin,
        varies: whMax !== whMin,
        currency_code: shopCurrency,
      };
    }

    return proxyJson({ wholesale: true, currency_code: shopCurrency, products });
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

    // Group products by their first collection. Only wholesale-available
    // variants appear; products with none are left off the line sheet.
    const collectionOrder: string[] = [];
    const collectionMap: Record<string, { title: string; products: any[] }> = {};

    for (const product of allNodes) {
      const hiddenIds = parseHiddenVariantIds(product.hiddenVariants?.value);
      const productActive = product.status === "ACTIVE";

      const variants = product.variants.nodes.flatMap((v: any) => {
        const variantId = parseInt(v.id.split("/").pop(), 10);
        const retailCents = Math.round(parseFloat(v.price) * 100);
        const state = resolveVariantWholesale({
          cms: cmsMap.get(String(variantId)),
          variantId,
          hiddenVariantIds: hiddenIds,
          productActive,
          customerType: session.customerType,
          retailCents,
        });
        if (!state.available) return [];

        return [{
          id: variantId,
          title: v.title,
          sku: v.sku ?? "",
          retail_price: retailCents,
          wh_price: state.priceCents,
          currency_code: shopCurrency,
          available: v.availableForSale,
          in_stock: v.inventoryQuantity ?? 0,
          moq: session.exemptFromMoq ? 1 : state.moq,
          case_size: state.caseSize,
        }];
      });

      if (variants.length === 0) continue;

      const col = product.collections?.nodes?.[0];
      const key = col?.handle ?? "__uncategorized__";
      const title = col?.title ?? "Other";

      if (!collectionMap[key]) {
        collectionMap[key] = { title, products: [] };
        collectionOrder.push(key);
      }

      collectionMap[key].products.push({
        id: parseInt(product.id.split("/").pop(), 10),
        title: product.title,
        handle: product.handle,
        image_url: product.featuredImage?.url ?? null,
        variants,
      });
    }

    return proxyJson({
      wholesale: true,
      collections: collectionOrder.map((k) => collectionMap[k]),
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
      const state = resolveVariantWholesale({
        cms: cmsMap.get(String(variantId)),
        variantId,
        hiddenVariantIds: hiddenIds,
        productActive,
        customerType: session.customerType,
        retailCents,
      });
      if (!state.available) return [];

      return [{
        id: variantId,
        gid: v.id,
        title: v.title,
        sku: v.sku ?? "",
        retail_price: retailCents,
        wh_price: state.priceCents,
        discount_percent: state.discountPercent,
        available: v.availableForSale,
        in_stock: v.inventoryQuantity ?? 0,
        moq: session.exemptFromMoq ? 1 : state.moq,
        case_size: state.caseSize,
        selected_options: v.selectedOptions,
        image_url: v.image?.url ?? null,
        currency_code: shopCurrency,
      }];
    });

    return proxyJson({
      wholesale: true,
      product_wholesale: variants.length > 0,
      product_id: productId,
      product_title: productData.title,
      variants,
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
  const rawLines: Array<{ variant_id: unknown; quantity: unknown }> = Array.isArray(payload?.lines)
    ? payload.lines
    : [];
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
            product {
              id
              title
              status
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
    lineItems.push({
      variantId: node.id,
      quantity: line.quantity,
      appliedDiscount: {
        valueType: "PERCENTAGE",
        value: discountPct,
        title: "Wholesale",
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

  let draftOrder: any;
  try {
    const draftRes = await admin.graphql(
      `#graphql
      mutation linesheetDraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name invoiceUrl totalPrice }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            lineItems,
            customerId: `gid://shopify/Customer/${wholesaleSession.shopifyCustomerId}`,
            tags: ["wholesale", "linesheet", ...(termsTag ? [termsTag] : [])],
            note: `Wholesale line sheet order${termsTag ? ` — payment terms ${termsTag.toUpperCase()}` : ""}.`,
          },
        },
      }
    );
    const draftData = await draftRes.json();
    const errors = draftData.data?.draftOrderCreate?.userErrors ?? [];
    if (errors.length > 0) {
      console.error("[app-proxy/linesheet-order] userErrors:", errors);
      return json({ error: "Failed to create order.", details: errors }, { status: 500 });
    }
    draftOrder = draftData.data?.draftOrderCreate?.draftOrder;
  } catch (err) {
    console.error("[app-proxy/linesheet-order] draftOrderCreate failed:", err);
    return json({ error: "Failed to create order" }, { status: 502 });
  }
  if (!draftOrder) {
    return json({ error: "Order not returned" }, { status: 500 });
  }

  const overallDiscountPct =
    retailSubtotalCents > 0
      ? Math.round((1 - subtotalCents / retailSubtotalCents) * 100)
      : 0;

  await db.wholesaleOrder.create({
    data: {
      shopifyDraftOrderId: draftOrder.id.split("/").pop() ?? "",
      orderName: draftOrder.name,
      shopifyCustomerId: wholesaleSession.shopifyCustomerId,
      paymentTerms: wholesaleSession.paymentTerms,
      totalAmount: subtotalCents,
      discountPercent: overallDiscountPct,
      isBackorder: false,
      orderTags: JSON.stringify(["wholesale", "linesheet", ...(termsTag ? [termsTag] : [])]),
      status: "PENDING",
    },
  });

  return proxyJson({
    ok: true,
    order_name: draftOrder.name,
    invoice_url: draftOrder.invoiceUrl,
    subtotal_cents: subtotalCents,
    item_count: lineItems.length,
    payment_terms: wholesaleSession.paymentTerms,
  });
}
