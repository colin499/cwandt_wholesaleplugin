# CW&T Wholesale App — Remaining Work

_Status snapshot: **2026-06-22**, after PR #1 merged to `main` (`8323af4`)._

This is the canonical "what's left" list. For architecture/setup details see `CLAUDE.md`.

---

## ✅ Done & merged (PR #1)

- **CMS price sync (Step 9)** — real token wired; `cms.cwandt.com/api/wholesale/variants/`
  returns 115 variants; `syncCmsDataToDb()` verified (cents correct). App Proxy serves real
  per-variant wholesale/distributor prices on product pages, flat-discount fallback otherwise.
- **Site-wide wholesale pricing** — `Wholesale $X` labels next to retail on collection / search /
  home cards (append-only, no flicker). Backend: `GET /apps/wholesale/catalog-prices`. Loader:
  app embed `wholesale-global.liquid`. Tuned to the Horizon card; generic fallback for other themes.
- **Default discount 40% → 50%** (storefront global rule, schema default + migration, webhook
  auto-approve, application approval, demo seed).
- **Fix:** removed the invalid `root.tsx` `headers` export (cleared 2 TS errors).

Verified on the **dev store** only. Nothing has touched the live store yet.

---

## 🔜 Remaining work (rough priority order)

### 1. Minimum-order warning — ✅ RESOLVED via cart-page block (2026-06-23)
- The `wholesale-checkout` Checkout UI extension is **Plus-only** and was **parked**
  (`_disabled_extensions/wholesale-checkout/`) — this store is not on Plus, so checkout-page app
  blocks can't be placed. See `CLAUDE.md` "Checkout UI Extension".
- **Live path:** add the **"Wholesale Cart Notice"** theme block
  (`wholesale-cart-notice.liquid`) on the **cart** template in the theme editor. It shows the
  minimum-order-not-met warning + free-shipping progress bar on any plan.
- **Still to do (manual, theme editor):** place that block on the cart template and set its
  Minimum Order Value to match Pricing Rules. Then place a test order as an approved wholesale
  customer and confirm the warning + **Net 30 / Net 60** payment terms behave.
- Note: this is **advisory only** (warns, can't hard-block). Hard blocking would need an Order
  Validation function (deferred).

### 2. Distributor discount rate — decision needed
- Wholesale default is now **50%**, which is **equal to the distributor default (50%)**.
- Decide whether distributors should be **deeper** (e.g. 60%). If yes it's a small change in:
  `webhooks.tsx` (`defaultDiscount`), `app.applications.tsx`, seed, and any per-customer rows.

### 3. Storefront setup / polish for Horizon
- Enable the **"Wholesale (site-wide)"** app embed in the theme editor (Theme → Customize →
  App embeds). This is what loads the wholesale JS site-wide.
- Place the **Wholesale Price Display** block on the product template.
- Verify `wholesale-price.liquid` retail-hiding CSS selectors match Horizon (they were written
  for Dawn). If retail price still shows through on PDPs, add Horizon's price selectors.
- Optional: revisit catalog-label styling (`.wh-card-price`) — currently "good for now".

### 4. Free-shipping delivery function (Step 8) — ✅ REBUILT (2026-06-23)
- Rebuilt as a modern JS function in `extensions/wholesale-free-shipping/` (target
  `cart.delivery-options.transform.run`). Builds to `dist/function.wasm` via the native CLI
  3.94 toolchain; `npm test` passes 3 integration tests. Old parked copy deleted.
- **Still needs, before it does anything in a real checkout:**
  - `shopify app deploy` (or `shopify app dev`) so the function is uploaded to the store; the
    `afterAuth` hook then auto-creates the delivery customization on next OAuth.
  - Add the **$0 "Wholesale Free Shipping" US rate** in Admin → Shipping → Manage rates FIRST,
    or the function hides all rates and checkout stalls with none available.
  - Test as an approved US wholesale customer: paid rates hidden, $0 rate remains; confirm a
    non-US / non-wholesale buyer still sees normal rates.

### 5. Go-live — **GATED** (do not start without Colin's explicit OK)
- Do **not** connect to the live store `cw-and-t.myshopify.com` until explicitly told.
- Steps when cleared:
  - Switch `schema.prisma` datasource provider `sqlite` → `postgresql`; set `DATABASE_URL` to
    Fly Postgres; `prisma migrate deploy` (already wired in the Dockerfile).
  - Deploy to **Fly.io** (region `ewr`, `shared-cpu-1x` 512 MB).
  - Set production env: `SHOPIFY_API_KEY/SECRET`, `SHOPIFY_APP_URL`, `CMS_BASE_URL`,
    `CMS_API_TOKEN`.
  - Install/authorize on the live store; run the storefront setup (§3) on the live theme;
    confirm CMS sync + pricing on real products (e.g. SKU `1PFLASH-1P` → $6.00 wholesale).

---

## 🧊 Deferred / Phase 2 (not now)
- Multi-currency / Shopify Markets for order minimums (needs a business decision).
- Minimum-order-value policy (dollar vs unit minimum) — Colin discussing with boss.
- Bring-your-own shipping label for large accounts.

## 🧹 Housekeeping
- Move the repo out of the iCloud-synced `~/Documents/CW&T` folder (avoids `" 2"` esbuild
  duplicate corruption that breaks the dev server).
