// CMS wholesale coverage audit: LIVE store catalog (public products.json)
// vs CmsVariantCache (synced from cms.cwandt.com production).
//
// Join key: SKU first (variant ids differ between live and dev stores),
// with variant-id match reported too. Output: every live variant not
// covered by a CMS row (= will NOT be wholesale-orderable), and CMS rows
// that match nothing live (stale).
import { execSync } from "node:child_process";

const DB = process.env.DB_PATH;

// 1. Live catalog via public products.json (published products only)
const liveVariants = [];
for (let page = 1; page <= 20; page++) {
  const res = await fetch(`https://cwandt.com/products.json?limit=250&page=${page}`);
  if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
  const { products } = await res.json();
  if (!products || products.length === 0) break;
  for (const p of products) {
    for (const v of p.variants) {
      liveVariants.push({
        productTitle: p.title,
        handle: p.handle,
        variantTitle: v.title,
        variantId: String(v.id),
        sku: (v.sku || "").trim(),
        price: v.price,
        available: v.available,
      });
    }
  }
  if (products.length < 250) break;
}

// 2. CMS rows from the synced cache
const rows = execSync(
  `sqlite3 -json "${DB}" "SELECT shopifyVariantId, sku, wholesalePriceCents, moq, cmsStatus FROM CmsVariantCache;"`
).toString();
const cms = JSON.parse(rows || "[]");
const cmsBySku = new Map(cms.filter((r) => r.sku).map((r) => [r.sku.trim(), r]));
const cmsById = new Map(cms.map((r) => [String(r.shopifyVariantId), r]));

// 3. Compare
const covered = [];
const missing = [];
for (const v of liveVariants) {
  const hit = (v.sku && cmsBySku.get(v.sku)) || cmsById.get(v.variantId);
  (hit ? covered : missing).push(v);
}
const liveSkus = new Set(liveVariants.map((v) => v.sku).filter(Boolean));
const liveIds = new Set(liveVariants.map((v) => v.variantId));
const stale = cms.filter(
  (r) => !(r.sku && liveSkus.has(r.sku.trim())) && !liveIds.has(String(r.shopifyVariantId))
);

console.log(`LIVE catalog: ${liveVariants.length} variants across ${new Set(liveVariants.map(v => v.handle)).size} published products`);
console.log(`CMS rows:     ${cms.length}`);
console.log(`Covered:      ${covered.length}`);
console.log(`NOT in CMS:   ${missing.length}  (not wholesale-orderable)`);
console.log(`CMS stale:    ${stale.length}  (match nothing in live catalog)`);
console.log(`\n── Live variants with NO CMS row ──`);
let lastP = "";
for (const v of missing) {
  if (v.productTitle !== lastP) { console.log(`\n${v.productTitle}  (/products/${v.handle})`); lastP = v.productTitle; }
  console.log(`   - ${v.variantTitle} · sku ${v.sku || "(none)"} · retail $${v.price}${v.available ? "" : " · sold out"}`);
}
console.log(`\n── Stale CMS rows (no live match) ──`);
for (const r of stale) console.log(`   - sku ${r.sku || "(none)"} · variantId ${r.shopifyVariantId} · $${(r.wholesalePriceCents / 100).toFixed(2)} · ${r.cmsStatus}`);
