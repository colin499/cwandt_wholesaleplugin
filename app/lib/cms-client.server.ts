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
    // Deliberately do NOT prune on an empty response — an empty payload is
    // far more likely a CMS problem than a real "everything left wholesale".
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

  // Prune rows no longer in the CMS response (removed from the program or
  // newly hidden). Without this, a variant removed in the CMS stayed
  // wholesale in the app forever — the cache only ever grew.
  const pruned = await db.cmsVariantCache.deleteMany({
    where: {
      shopifyVariantId: { notIn: variants.map((v) => String(v.shopify_variant_id)) },
    },
  });
  if (pruned.count > 0) {
    console.log(`[cms-client] Pruned ${pruned.count} variants no longer in the CMS response`);
  }

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

export type CmsLookupEntry = { id: number | string; sku?: string | null };

/**
 * Batch-fetch CMS data for a list of variants. Returns a Map keyed by the
 * variant ID string that was ASKED FOR. Variants not in the CMS are absent
 * from the Map — after Phase A that means "not available for wholesale".
 *
 * Matching: variant ID first (the CMS stores LIVE-store variant IDs, so this
 * is the normal path in production), then SKU as a fallback for entries that
 * carry one. The fallback exists because the dev store's products are copies
 * with different IDs but the same SKUs; it is harmless on the live store,
 * where the ID match always wins.
 */
export async function getCmsVariantMap(
  entries: (number | string | CmsLookupEntry)[]
): Promise<Map<string, CmsCachedVariant>> {
  if (entries.length === 0) return new Map();

  const normalized: CmsLookupEntry[] = entries.map((e) =>
    typeof e === "object" ? e : { id: e }
  );
  const ids = normalized.map((e) => String(e.id));

  const select = {
    shopifyVariantId: true,
    sku: true,
    wholesalePriceCents: true,
    distributorPriceCents: true,
    moq: true,
  } as const;

  const idRows = await db.cmsVariantCache.findMany({
    where: { shopifyVariantId: { in: ids } },
    select,
  });

  const map = new Map<string, CmsCachedVariant>();
  const toCached = (row: (typeof idRows)[number]): CmsCachedVariant => ({
    wholesalePriceCents: row.wholesalePriceCents,
    distributorPriceCents: row.distributorPriceCents,
    moq: row.moq,
  });
  for (const row of idRows) map.set(row.shopifyVariantId, toCached(row));

  // SKU fallback for entries the ID lookup missed.
  const missing = normalized.filter(
    (e) => !map.has(String(e.id)) && e.sku && e.sku.trim() !== ""
  );
  if (missing.length > 0) {
    const skuRows = await db.cmsVariantCache.findMany({
      where: { sku: { in: missing.map((e) => e.sku!.trim()) } },
      select,
    });
    const bySku = new Map(skuRows.map((r) => [r.sku, r]));
    for (const e of missing) {
      const row = bySku.get(e.sku!.trim());
      if (row) map.set(String(e.id), toCached(row));
    }
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
// Wholesale availability + price resolution
//
// A variant is available for wholesale iff:
//   1. it has a CMS row (presence in CmsVariantCache = curated into the
//      program — the CMS WholesaleVariant table is the source of truth),
//   2. it is NOT listed in the product's custom.wholesale_hidden_variants
//      metafield (the projection the live theme's variant picker also reads),
//   3. its product is ACTIVE in Shopify.
//
// There is deliberately NO fallback price for variants outside the program:
// not in the CMS means not wholesale, full stop. (The old flat-discount
// fallback made every product wholesale-buyable by default.)
// ---------------------------------------------------------------------------

/**
 * Parses the custom.wholesale_hidden_variants product metafield value into a
 * set of numeric variant-id strings. The metafield holds a JSON array of
 * variant GIDs (or a single GID string); tolerate both, plus junk.
 */
export function parseHiddenVariantIds(raw: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  let entries: unknown[] = [];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = [raw];
  }
  for (const entry of entries) {
    const match = /(\d+)\s*$/.exec(String(entry));
    if (match) ids.add(match[1]);
  }
  return ids;
}

export type VariantWholesaleState =
  | { available: true; priceCents: number; moq: number; discountPercent: number }
  | { available: false };

/**
 * Resolves a single variant's wholesale state from data the caller already
 * has in hand. discountPercent is derived (retail vs CMS price) for display.
 */
export function resolveVariantWholesale(opts: {
  cms: CmsCachedVariant | undefined;
  variantId: number | string;
  hiddenVariantIds: Set<string>;
  productActive: boolean;
  customerType: string;
  retailCents: number;
}): VariantWholesaleState {
  const { cms, variantId, hiddenVariantIds, productActive, customerType, retailCents } = opts;
  if (!cms || !productActive || hiddenVariantIds.has(String(variantId))) {
    return { available: false };
  }
  const priceCents =
    customerType === "DISTRIBUTOR" ? cms.distributorPriceCents : cms.wholesalePriceCents;
  const discountPercent =
    retailCents > 0 ? Math.round((1 - priceCents / retailCents) * 100) : 0;
  return { available: true, priceCents, moq: cms.moq, discountPercent };
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
