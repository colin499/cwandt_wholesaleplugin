/**
 * CW&T CMS API client + local DB cache
 *
 * The CMS exposes one endpoint consumed by this app:
 *   GET /api/wholesale/variants/
 *   Authorization: Bearer <CMS_API_TOKEN>
 *
 * Rather than hitting the CMS on every storefront request, we cache the full
 * response in CmsVariantCache (Prisma/SQLite). The cache is refreshed:
 *   - Manually via the CMS Sync admin page (/app/cms-sync)
 *   - Automatically in the background if data is older than CACHE_TTL_MS
 *
 * Set these env vars to activate:
 *   CMS_BASE_URL=https://cms.cwandt.com   ← swap in once VPS is deployed
 *   CMS_API_TOKEN=<token matching WHOLESALE_API_TOKEN on the VPS>
 */

import { db } from "../db.server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export type CmsWholesaleVariant = {
  shopify_variant_id: number;
  sku: string;
  wholesale_price: number;   // dollars, e.g. 12.50
  distributor_price: number; // dollars, e.g. 9.00
  moq: number;
  in_stock: number;          // from CMS Variant; not used for stock display (Shopify is authoritative)
  status: string;
};

function getCmsConfig() {
  const baseUrl = process.env.CMS_BASE_URL;
  const token = process.env.CMS_API_TOKEN;
  return { baseUrl, token, configured: !!(baseUrl && token) };
}

// ---------------------------------------------------------------------------
// Raw API fetch (hits the live CMS endpoint)
// ---------------------------------------------------------------------------

export async function fetchWholesalePricing(): Promise<CmsWholesaleVariant[]> {
  const { baseUrl, token, configured } = getCmsConfig();
  if (!configured) {
    console.warn("[cms-client] CMS_BASE_URL or CMS_API_TOKEN not set — skipping sync");
    return [];
  }

  const response = await fetch(`${baseUrl}/api/wholesale/variants/`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`CMS API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<CmsWholesaleVariant[]>;
}

// ---------------------------------------------------------------------------
// DB sync — fetch from CMS and upsert into CmsVariantCache
// ---------------------------------------------------------------------------

export async function syncCmsDataToDb(): Promise<{ count: number; error?: string }> {
  let variants: CmsWholesaleVariant[];
  try {
    variants = await fetchWholesalePricing();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[cms-client] fetchWholesalePricing failed:", error);
    await db.cmsSyncState
      .upsert({
        where: { id: "singleton" },
        create: { id: "singleton", lastError: error },
        update: { lastError: error },
      })
      .catch(() => {});
    return { count: 0, error };
  }

  if (variants.length === 0) {
    return { count: 0 };
  }

  // Upsert all variants in parallel — each is independent
  await Promise.all(
    variants.map((v) => {
      const data = {
        sku: v.sku || "",
        wholesalePriceCents: Math.round(v.wholesale_price * 100),
        distributorPriceCents: Math.round(v.distributor_price * 100),
        moq: v.moq || 1,
        cmsStatus: v.status || "",
      };
      return db.cmsVariantCache.upsert({
        where: { shopifyVariantId: String(v.shopify_variant_id) },
        create: { shopifyVariantId: String(v.shopify_variant_id), ...data },
        update: data,
      });
    })
  );

  await db.cmsSyncState.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      lastSyncedAt: new Date(),
      variantCount: variants.length,
      lastError: null,
    },
    update: {
      lastSyncedAt: new Date(),
      variantCount: variants.length,
      lastError: null,
    },
  });

  console.log(`[cms-client] Synced ${variants.length} variants from CMS`);
  return { count: variants.length };
}

// ---------------------------------------------------------------------------
// Cache reads — used by App Proxy on every storefront request
// ---------------------------------------------------------------------------

export type CmsCachedVariant = {
  wholesalePriceCents: number;
  distributorPriceCents: number;
  moq: number;
};

/**
 * Batch-fetch CMS data for a list of numeric Shopify variant IDs.
 * Returns a Map keyed by variant ID string. Missing variants (not in CMS) are
 * absent from the Map — callers should fall back to calculated prices.
 */
export async function getCmsVariantMap(
  shopifyVariantIds: (number | string)[]
): Promise<Map<string, CmsCachedVariant>> {
  if (shopifyVariantIds.length === 0) return new Map();

  const ids = shopifyVariantIds.map(String);
  const rows = await db.cmsVariantCache.findMany({
    where: { shopifyVariantId: { in: ids } },
    select: {
      shopifyVariantId: true,
      wholesalePriceCents: true,
      distributorPriceCents: true,
      moq: true,
    },
  });

  const map = new Map<string, CmsCachedVariant>();
  for (const row of rows) {
    map.set(row.shopifyVariantId, {
      wholesalePriceCents: row.wholesalePriceCents,
      distributorPriceCents: row.distributorPriceCents,
      moq: row.moq,
    });
  }
  return map;
}

/**
 * Single-variant cache lookup. Returns null if the variant is not in the cache.
 */
export async function getCmsVariant(
  shopifyVariantId: number | string
): Promise<CmsCachedVariant | null> {
  return db.cmsVariantCache.findUnique({
    where: { shopifyVariantId: String(shopifyVariantId) },
    select: { wholesalePriceCents: true, distributorPriceCents: true, moq: true },
  });
}

// ---------------------------------------------------------------------------
// Sync state — used by the admin sync page
// ---------------------------------------------------------------------------

export async function getCmsSyncState() {
  return db.cmsSyncState.findUnique({ where: { id: "singleton" } });
}

// ---------------------------------------------------------------------------
// Background refresh — fire-and-forget if cache is stale
// Called from App Proxy loader; intentionally not awaited by callers.
// ---------------------------------------------------------------------------

export async function maybeRefreshCmsCache(): Promise<void> {
  const { configured } = getCmsConfig();
  if (!configured) return;

  const state = await db.cmsSyncState.findUnique({ where: { id: "singleton" } });
  const ageMs = state?.lastSyncedAt
    ? Date.now() - new Date(state.lastSyncedAt).getTime()
    : Infinity;

  if (ageMs > CACHE_TTL_MS) {
    syncCmsDataToDb().catch((err) =>
      console.error("[cms-client] Background cache refresh failed:", err)
    );
  }
}
