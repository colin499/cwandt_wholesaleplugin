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
  getActiveGlobalDiscount,
  applyVolumeTier,
  calculateWholesalePrice,
  getEffectiveOrderMinimum,
} from "../lib/wholesale-customer.server";
import {
  getCmsVariantMap,
  maybeRefreshCmsCache,
} from "../lib/cms-client.server";
import { db } from "../db.server";

// Admin API query — fetches products for the line sheet (paginated).
const LINESHEET_QUERY = `
  query GetLinesheetProducts($first: Int!, $after: String) {
    shop { currencyCode }
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          featuredImage { url altText }
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
        variants(first: 100) {
          nodes { id price availableForSale }
        }
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

    const baseDiscount = await getActiveGlobalDiscount(session.discountPercent);
    const effectiveDiscount = await applyVolumeTier(baseDiscount, 1);
    const isDistributor = session.customerType === "DISTRIBUTOR";

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
      p.variants.nodes.map((v: any) => parseInt(v.id.split("/").pop(), 10))
    );
    const cmsMap = await getCmsVariantMap(allVariantIds);

    const products: Record<string, any> = {};
    for (const p of nodes) {
      let whMin = Infinity;
      let whMax = -Infinity;
      let retailMin = Infinity;
      for (const v of p.variants.nodes) {
        const retailCents = Math.round(parseFloat(v.price) * 100);
        const cms = cmsMap.get(String(v.id.split("/").pop()));
        const wh = cms
          ? isDistributor
            ? cms.distributorPriceCents
            : cms.wholesalePriceCents
          : calculateWholesalePrice(retailCents, effectiveDiscount);
        if (wh < whMin) whMin = wh;
        if (wh > whMax) whMax = wh;
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

    const baseDiscount = await getActiveGlobalDiscount(session.discountPercent);
    // Line sheet shows base wholesale price — volume tier discounts apply at order time
    const effectiveDiscount = await applyVolumeTier(baseDiscount, 1);

    // Paginate through ALL published products — no artificial cap.
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
      p.variants.nodes.map((v: any) => parseInt(v.id.split("/").pop(), 10))
    );
    const cmsMap = await getCmsVariantMap(allVariantIds);
    const isDistributor = session.customerType === "DISTRIBUTOR";

    // Group products by their first collection
    const collectionOrder: string[] = [];
    const collectionMap: Record<string, { title: string; products: any[] }> = {};

    for (const product of allNodes) {
      const col = product.collections?.nodes?.[0];
      const key = col?.handle ?? "__uncategorized__";
      const title = col?.title ?? "Other";

      if (!collectionMap[key]) {
        collectionMap[key] = { title, products: [] };
        collectionOrder.push(key);
      }

      const variants = product.variants.nodes.map((v: any) => {
        const variantId = parseInt(v.id.split("/").pop(), 10);
        const retailCents = Math.round(parseFloat(v.price) * 100);
        const cms = cmsMap.get(String(variantId));

        let whPrice: number;
        if (cms) {
          whPrice = isDistributor ? cms.distributorPriceCents : cms.wholesalePriceCents;
        } else {
          whPrice = calculateWholesalePrice(retailCents, effectiveDiscount);
        }

        return {
          id: variantId,
          title: v.title,
          sku: v.sku ?? "",
          retail_price: retailCents,
          wh_price: whPrice,
          currency_code: shopCurrency,
          available: v.availableForSale,
          in_stock: v.inventoryQuantity ?? 0,
          moq: cms?.moq ?? 1,
        };
      });

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
      discount_percent: effectiveDiscount,
      collections: collectionOrder.map((k) => collectionMap[k]),
    });
  }

  // ── /apps/wholesale/prices ───────────────────────────────────────────────
  if (subpath === "prices") {
    const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");
    const productId = url.searchParams.get("product_id");
    const qty = parseInt(url.searchParams.get("qty") ?? "1", 10) || 1;

    if (!productId) {
      return json({ error: "product_id is required" }, { status: 400 });
    }

    const session = await getWholesaleSession(shopifyCustomerId);
    if (!session) return notWholesale();

    const baseDiscount = await getActiveGlobalDiscount(session.discountPercent);
    const effectiveDiscount = await applyVolumeTier(baseDiscount, qty);

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

    const variantIds = productData.variants.nodes.map((v: any) =>
      parseInt(v.id.split("/").pop(), 10)
    );
    const cmsMap = await getCmsVariantMap(variantIds);
    const isDistributor = session.customerType === "DISTRIBUTOR";

    const variants = productData.variants.nodes.map((v: any) => {
      const retailCents = Math.round(parseFloat(v.price) * 100);
      const variantNumericId = v.id.split("/").pop();
      const variantId = parseInt(variantNumericId, 10);
      const cms = cmsMap.get(String(variantId));

      let whPrice: number;
      if (cms) {
        whPrice = isDistributor ? cms.distributorPriceCents : cms.wholesalePriceCents;
      } else {
        whPrice = calculateWholesalePrice(retailCents, effectiveDiscount);
      }

      return {
        id: variantId,
        gid: v.id,
        title: v.title,
        sku: v.sku ?? "",
        retail_price: retailCents,
        wh_price: whPrice,
        discount_percent: effectiveDiscount,
        available: v.availableForSale,
        in_stock: v.inventoryQuantity ?? 0,
        moq: cms?.moq ?? 1,
        selected_options: v.selectedOptions,
        image_url: v.image?.url ?? null,
        currency_code: shopCurrency,
      };
    });

    return proxyJson({
      wholesale: true,
      product_id: productId,
      product_title: productData.title,
      discount_percent: effectiveDiscount,
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

  const baseDiscount = await getActiveGlobalDiscount(wholesaleSession.discountPercent);
  const effectiveDiscount = await applyVolumeTier(baseDiscount, quantity);

  // Admin API client — loads the shop's offline session from Prisma storage.
  // This works because the app is installed on the shop (App Proxy only runs when installed).
  const { admin } = await unauthenticated.admin(shop);

  const variantGid = `gid://shopify/ProductVariant/${variantId}`;
  const customerGid = `gid://shopify/Customer/${wholesaleSession.shopifyCustomerId}`;

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
