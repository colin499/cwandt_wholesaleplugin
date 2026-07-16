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

### 2. Distributor discount rate — decision needed (mechanism now trivial)
- Wholesale and distributor both sit at **50%**; whether distributors go deeper
  (e.g. 60%) is still an open business decision.
- **The code change is gone** (2026-07-10 restructure): rates live in
  `PricingProfile` rows, editable in the app under **Pricing → Pricing
  Profiles**. When decided, change the Distributor profile's percentage there —
  every distributor without a per-customer override follows immediately.

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
- Live store is `thehundredthmonkey.myshopify.com` (public domain cwandt.com; the
  `cw-and-t.myshopify.com` domain in older docs never existed). Go-live began 2026-07-16.
- Steps when cleared:
  - ~~Switch schema provider~~ DONE differently (2026-07-15): production uses
    `prisma/production/schema.prisma` (postgresql) + its own migrations; dev stays SQLite.
    Dockerfile already wired. Set `DATABASE_URL` via `fly postgres attach`.
  - Create the **production Shopify app** (`shopify app config link` → new app, fixed
    fly.dev URLs) so `shopify app dev` can never clobber live config; deploy extensions +
    config with `shopify app deploy --config production`.
  - Deploy to **Fly.io** (region `ewr`, `shared-cpu-1x` 512 MB): `fly apps create
    cwandt-wholesale`, `fly postgres create` + `attach`, `fly secrets set
    SHOPIFY_API_KEY/SECRET SHOPIFY_APP_URL CMS_BASE_URL CMS_API_TOKEN`, `fly deploy`.
  - Tag heavy products (`no-free-shipping-wholesale`: Superlocal, Time Since Launch) and
    add the $0 US rate named exactly "Wholesale Free Shipping" on the live store.
  - Set production env: `SHOPIFY_API_KEY/SECRET`, `SHOPIFY_APP_URL`, `CMS_BASE_URL`,
    `CMS_API_TOKEN`.
  - Install/authorize on the live store; run the storefront setup (§3) on the live theme;
    confirm CMS sync + pricing on real products (e.g. SKU `1PFLASH-1P` → $6.00 wholesale).
  - **Run the backfill** (Customers page → Import & Reconcile → Dry run, review, then
    Apply). Existing customers tagged `wholesale`/`distributor` before install are
    invisible to the app until this runs — webhooks only cover events from install
    forward.
  - **Tell staff the workflow changed** (2026-07-10 restructure): tagging a customer in
    Shopify Admin no longer onboards them (tags self-heal to match the app). Onboard,
    suspend, and change customer types in the app's Customers page only.
  - **Set up the staff alert for wholesale draft orders** (Shopify Flow): trigger
    "Draft order created" → condition: tags contain `wholesale` → action: send internal
    email. Catches pay-later drafts and backorder drafts that never become orders on
    their own. (NET-30/60 orders auto-complete into the shipping queue as of 2026-07-15;
    everything else still starts as a draft.)
  - **Re-run the CMS coverage audit against the live program**
    (`node scripts/cms-coverage.mjs`, `DB_PATH=<prod db or local copy>`): compares
    cwandt.com's public catalog to synced CMS rows by SKU, lists every variant that
    won't be wholesale-orderable. Taylor wants to exercise the CMS curation workflow
    live (2026-07-15 audit: 112/325 variants covered; ~85 sellable candidates missing,
    rest is $0/no-SKU portfolio noise).

---

## 🧹 BSS decommission — live-theme cleanup (BSS uninstalled 2026-07-16)

BSS B2B was uninstalled from the live store on 2026-07-16 (uninstall = subscription
cancelled, if Shopify-billed — Taylor verifying in Settings → Billing). Apps can't
remove their theme edits, so this residue remains on the live theme (`main` branch of
`cwandt-shopify-theme`) and needs cleanup commits:

- [ ] `sections/main-product.liquid` (~line 392): the `customer.tags contains
      'Wholesale' / 'Distributor'` (capital-W, BSS-era) conditional under the variant
      picker. Remove the "You are logged in as a wholesaler/distributor…" messages
      (the app's PDP block replaces them), but KEEP the `#infiniteoptions-container`
      hiding — rewritten to lowercase `wholesale`/`distributor`/`b2b` tag checks so it
      applies to app-managed customers (Taylor's explicit request 2026-07-16: hide
      Infinite Options for logged-in wholesale customers).
- [ ] Delete dead BSS files: `snippets/bss-*.liquid` (11 files),
      `assets/bss-lock-settings.css`, `templates/search.bss.b2b.liquid`.
- [ ] Check `bss-lock-condition.liquid` render sites elsewhere in the theme before
      deleting (grep for `render 'bss-` / `include 'bss-`).
- [ ] Legacy capital-W `Wholesale`/`Distributor` customer tags stay on customer
      records (the app's sync only manages lowercase tags and won't strip them);
      after the theme cleanup they're inert. Optional later: bulk-remove.
- Confirm first: is the theme repo `main` branch connected to the live theme
  (GitHub auto-deploy), or does cleanup need a manual theme upload?

## 🧊 Deferred / Phase 2 (not now)
- Multi-currency / Shopify Markets for order minimums (needs a business decision).
- Minimum-order-value policy (dollar vs unit minimum) — Colin discussing with boss.
- Bring-your-own shipping label for large accounts.

## 🧹 Housekeeping
- ~~Move the repo out of the iCloud-synced `~/Documents/CW&T` folder~~ — ✅ done; repo
  now lives at `~/Development/cwandt-wholesale-plugin`.

## 🔄 2026-07-10 — Customer architecture restructure (branch `feat/unified-customers`)
- Customers + Distributors merged into one **Customers** page (type tabs incl. B2B);
  search the whole Shopify customer list and enroll from the app; per-row type changes.
- **PricingProfile** table: per-segment rates editable in Pricing → Pricing Profiles;
  per-customer discount is now an optional override (null = profile rate).
- **Tags are no longer an input**: webhooks reconcile and self-heal tag edits in both
  directions; enrollment only via the app. See CLAUDE.md "Customer Account Architecture".
- **Import & Reconcile** sweep on the Customers page (dry-run default) backfills
  pre-app tagged customers and repairs projection drift.
- Still to do before merge: exercise end-to-end against the dev store (enroll → tags in
  Admin → storefront pricing → suspend → revoked), and brief Colin on the workflow change.
