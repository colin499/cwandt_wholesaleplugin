# CW&T Wholesale App — Claude Code Reference

Custom Shopify B2B wholesale app. Replaces a paid third-party B2B app. Built with
Remix + TypeScript + Prisma + Shopify App Extensions.

## Tech Stack

- **Framework**: `@shopify/shopify-app-remix` v3 (Remix + TypeScript)
- **Admin UI**: Shopify Polaris v13 (fully controlled components — no `defaultValue`)
- **Database**: Prisma + SQLite (local dev) → switch provider to `postgresql` for Fly.io
- **Hosting**: Fly.io, region `ewr` (Newark), `shared-cpu-1x` 512 MB
- **Storefront**: Theme App Extensions only — never edit theme files directly
- **API version**: Shopify January 2025

## Local Development

Run dev with **`./dev-start.sh`** — it runs standard `shopify app dev`. The CLI manages **one**
cloudflare tunnel that serves both the embedded app and the extensions, and auto-updates
`application_url`, redirect URLs, and `[app_proxy].url` in the Partner Dashboard
(`automatically_update_urls_on_dev = true`). Wait for `✅ Ready, watching for changes`, then press
`p` to open the preview. No manual Partner-Dashboard URL editing is needed.

**cloudflared must be the Homebrew build, not the CLI's bundled one.** The bundled binary
(2024.8.2) is rejected by Cloudflare's edge (`Register tunnel error … "Unauthorized: Tunnel not
found"`) — the tunnel dies within the hour and the CLI freezes at "Preparing dev preview".
`dev-start.sh` forces the current binary via `SHOPIFY_CLI_CLOUDFLARED_PATH`. One-time prereq:
`brew install cloudflared`.

**Two config invariants — do NOT revert these (reverting either causes `Invalid path /`):**
- `shopify.web.toml` must include the **`frontend`** role (`roles = ["background", "frontend"]`).
  With `type = "backend"` the CLI proxy refuses to serve `/`.
- `vite.config.ts` `server.port` must be **`Number(process.env.PORT || 3000)`** (HMR derived from
  `SHOPIFY_APP_URL` / `FRONTEND_PORT`). Never hardcode `61733` / `strictPort` — the CLI assigns the
  frontend port and proxies to it; a hardcoded port makes the proxy forward nowhere → timeout.

**Do NOT reintroduce `dev-proxy.mjs` or `shopify app dev --tunnel-url`.** That was an abandoned
workaround for the stale-cloudflared problem; it is incompatible with standard dev and caused
multi-day freezes. `dev-proxy.mjs` is now dead code.

**iCloud sync caveat — resolved:** the repo now lives at
`~/Development/cwandt-wholesale-plugin`, outside iCloud "Desktop & Documents"
sync. (Historical: under `~/Documents/CW&T`, sync created `" 2"` duplicate
binaries inside `node_modules` and corrupted builds. Keep the repo out of any
synced folder.)

### Troubleshooting "the dev server is broken"

| Symptom | Cause | Fix |
|---|---|---|
| Frozen at "Preparing dev preview"; cloudflared log loops `Unauthorized: Tunnel not found` | Stale bundled cloudflared rejected by Cloudflare edge | `brew install cloudflared` (already wired via `SHOPIFY_CLI_CLOUDFLARED_PATH`); Ctrl+C and re-run `./dev-start.sh` |
| Preview page says `Invalid path /…` | `shopify.web.toml` not `frontend`, or `vite.config.ts` hardcodes the port | Restore the two invariants above; restart dev |
| An extension/function build hangs silently (proc alive, 0% CPU, no output) | A function's `[extensions.build].command` recursively re-invokes `shopify app function build`, deadlocking on `.build-lock` | Leave `command = ""` for JS functions — CLI 3.94 builds them natively (esbuild→Javy). Never point `command` at a script that calls `shopify app function build` |
| `Host version X does not match binary Y`, or weird esbuild failures | iCloud sync corrupted an esbuild binary | `find node_modules -name "* 2"`, then `npm ci`; move repo off iCloud |

## Build Status

- [x] Step 1: App scaffolded (Remix, TypeScript, Shopify CLI)
- [x] Step 2: Prisma schema (SQLite, 7 models), migrations run, db.server.ts
- [x] Step 3: `wholesale-customer.server.ts` middleware, login delay bug fix (3-layer)
- [x] Step 4: App Proxy route, Theme App Extension blocks + assets
- [x] Step 5: Out-of-stock / backorder (Draft Order API bypass)
- [x] Step 6: Cart validation (min cart value — Checkout UI Extension)
- [x] Step 7: HTML line sheet (client-side print CSS + html2pdf.js)
- [x] Step 8: Shipping rule (Shopify Functions Delivery Customization) — rebuilt 2026-06-23 as a
      modern JS function (`type = "function"`, target `cart.delivery-options.transform.run`),
      builds to `dist/function.wasm` via the native CLI 3.94 toolchain, 3 passing integration
      tests. Lives in `extensions/wholesale-free-shipping/`. See below.
- [ ] Step 9: CMS sync (GET /api/wholesale/variants/ endpoint on cms.cwandt.com)
- [ ] Step 10: Admin dashboard polish

## Customer Account Architecture (restructured 2026-07-10)

**The local `WholesaleCustomer` row is the single source of truth for account
state.** Shopify carries two WRITE-ONLY projections of it, each existing because
of a platform constraint:

- **Customer tags** (`wholesale`, plus `distributor`/`b2b` by type) — the only
  signal Liquid theme blocks can read cheaply. Also useful for Admin segments.
- **`wholesale.status` customer metafield** — the only signal Shopify Functions
  and Checkout UI extensions can read (they cannot see tags / call the app).

Both are written exclusively by `syncCustomerToShopify()` in
`app/lib/enrollment.server.ts`. **Nothing reads them back as authority.**

Rules that follow (do not regress these):

- **Enrollment happens only in the app** — via the Customers page (search any
  Shopify customer / create by email) or application approval. Both call
  `enrollCustomer()`. Hand-tagging a customer in Shopify Admin does NOT create
  an account (the old auto-approve-at-default-discount webhook path is dead).
- **Tags self-heal.** `reconcileCustomerFromWebhook()` compares the managed
  tags on every customer webhook against the exact set the DB prescribes and
  rewrites them on any mismatch, in either direction. Removing the tag in
  Admin does not offboard anyone — it comes back. Suspend/approve/type-change
  only work in the app.
- **Pricing comes from `PricingProfile` rows** (fixed ids `pp_wholesale`,
  `pp_distributor`, `pp_b2b`, seeded by migration). `customerType` is
  segmentation only. Per-customer `discountPercent` is a nullable override;
  null = profile rate. Effective rate = `resolveDiscountPercent()`:
  override ?? profile ?? 50. Adding a segment = new profile row, not code.
  Profiles are edited in Pricing → Pricing Profiles.
- **Backfill/reconcile sweep** (`backfillFromShopify()`, run from the
  Customers page → Import & Reconcile): enrolls Shopify customers tagged
  before the app existed and repairs any tag/metafield drift (e.g. edits made
  while the app was down and webhooks were dropped). Dry-run by default.
  **Must be run once after installing on the live store** — webhooks only
  cover events from install-time forward.

## Wholesale Pricing Architecture (Phase A, 2026-07-12)

**Per-variant CMS prices are the only wholesale prices.** A variant is
available for wholesale iff (all three):

1. it has a row in the CMS `WholesaleVariant` table (synced into
   `CmsVariantCache`; presence = curated into the program),
2. it is NOT listed in the product's `custom.wholesale_hidden_variants`
   metafield (same projection the live theme's variant picker reads),
3. its Shopify product status is ACTIVE.

Resolution lives in `resolveVariantWholesale()` / `parseHiddenVariantIds()`
in `app/lib/cms-client.server.ts` and is applied by every App Proxy endpoint
(prices, linesheet-data, orders, backorder). **There is no fallback
price** — not in the CMS means not wholesale: no price shown,
not on the line sheet, backorder rejected. On the PDP, `wholesale.js` reveals
the theme's retail price (`html.wh-show-retail`) when a product isn't in the
program, since the price block's CSS pre-emptively hides retail for wholesale
customers.

The percentage-discount system (GLOBAL_DISCOUNT / VOLUME_TIER /
PRODUCT_OVERRIDE PricingRules, maxDiscountPercent stacking cap) is **retired**
— removed from code and admin UI. The `PricingRule` table and
`WholesaleSettings.maxDiscountPercent` column still exist but are read by
nothing; drop in a future cleanup migration. `PricingProfile` rows carry
per-segment payment terms / minimums and the customer-level discount metadata
used for order records — not storefront prices.

The program is managed in the CMS: cms.cwandt.com → Wholesale (list, add
products with per-variant prices/MOQ at the 50%/30% tier presets, remove).

**Catalog-card "Wholesale $X" labels — REMOVED (2026-07-14, by request).** The
theme's collection/search cards are image + title only (no retail price), and
Taylor wants them kept that way. The card-label JS in wholesale.js, the
`/apps/wholesale/catalog-prices` endpoint, and `.wh-card-price` CSS were all
deleted. Do not reintroduce card price labels.

## Linesheet-Centric Ordering (2026-07-13)

**The linesheet is the ONLY wholesale ordering surface.** The theme cart is
never repriced (no discount function) — for wholesale customers the PDP is
purely informational: `wholesale-price.liquid` hides `.product-form__quantity`
and `.product-form__buttons` (revealed again via `html.wh-show-retail` on
non-program products) and shows an MSRP/WHOLESALE/MOQ table plus an
"Order on Linesheet →" link (block setting `linesheet_url`, default
`/pages/linesheet`, opens a new tab).

Linesheet drafts persist in `LinesheetDraft` (one active DRAFT per customer,
autosaved ~800ms after edits via POST `/apps/wholesale/linesheet-draft`).
Submitting flips the row to SUBMITTED (order name + Shopify draft order id).
Admin view: /app/linesheets ("Order Sheets" nav).

**Customer order history lives on its own Orders page** (2026-07-14): theme
block `wholesale-orders.liquid` + `orders.js` on `/pages/orders` (linked from
`wholesale-nav` and a "Previous orders →" link on the sheet). GET
`/apps/wholesale/orders` lists SUBMITTED sheets with live status derived from
the stored Shopify draft order id (SUBMITTED → INVOICE_SENT → PREPARING →
PARTIALLY_SHIPPED → SHIPPED / CANCELLED; display copy is the STATUS_TEXT map
in orders.js); `?id=` returns line detail (unit prices are *current* CMS
prices — stored subtotal is as-submitted). "Reorder" copies a sheet into the
active draft via the existing POST `/apps/wholesale/linesheet-duplicate` and
redirects to the sheet, which prefills from the draft. Note: a split
stock+backorder submission stores only the primary draft order id, so status
tracks the payable order.

## Key Decisions

| Decision | Choice | Why |
|---|---|---|
| Login delay bug | 3-layer: `{% style %}` + `<meta name="wh-customer">` + sessionStorage | No async, no race condition |
| Backorder | Draft Order API bypass | Avoid `inventoryPolicy: CONTINUE` globally |
| Line sheet PDF | Client-side `@media print` + html2pdf.js | No server rendering needed |
| Shipping | Shopify Functions Delivery Customization | Always free US wholesale |
| Storefront UI | Theme App Extensions only | Shopify requirement, merchant-agnostic |

## Critical Constraints

- CMS repo (`github.com/cheewee2000/cwandt-cms`) — commits are allowed but scope is narrow: only add what is explicitly planned and reviewed before writing
- The live store's myshopify domain is **`thehundredthmonkey.myshopify.com`** (legacy store
  name; public domain is cwandt.com, admin at admin.shopify.com/store/thehundredthmonkey).
  `cw-and-t.myshopify.com` does NOT exist — old docs referencing it are wrong. Go-live began
  2026-07-16; live-store work is now authorized.
- All storefront UI via Theme App Extensions only — no direct theme file edits
- The only planned CMS change: add one read-only endpoint (`GET /api/wholesale/variants/`)

## File Map

```
app/
  db.server.ts                       — PrismaClient singleton (hot-reload safe)
  shopify.server.ts                  — Shopify app config, webhooks, auth
  lib/
    wholesale-customer.server.ts     — Core middleware (getWholesaleSession, pricing math)
    enrollment.server.ts             — Source-of-truth machinery: enrollCustomer, syncCustomerToShopify,
                                       reconcileCustomerFromWebhook, backfillFromShopify, pricing profile ids
    cms-client.server.ts             — CMS API client stub (Step 9)
  routes/
    app._index.tsx                   — Dashboard
    app.customers.tsx                — Unified Customers page: all types (wholesale/distributor/b2b) with
                                       filter tabs, Shopify-wide search + enroll, per-row type/status/minimum,
                                       Import & Reconcile (backfill) card
    app.distributors.tsx             — Redirect → /app/customers (merged 2026-07-10)
    app.applications.tsx             — Application review (approve / reject) — approve calls enrollCustomer
    app.pricing.tsx                  — Pricing profiles (terms/minimums) + order minimums;
                                       product prices live in the CMS, not here
    app-proxy.$.tsx                  — App Proxy: /apps/wholesale/prices, /order-minimums
    webhooks.tsx                     — Shopify webhook handler (customer webhooks reconcile, never enroll)

extensions/wholesale-ui/
  blocks/
    wholesale-price.liquid           — Product page price display (the bug-fix block)
    wholesale-badge.liquid           — Header badge + <meta name="wh-customer"> KEY
    wholesale-cart-notice.liquid     — Cart MOQ warning + shipping progress bar
    wholesale-nav.liquid             — Wholesale-only nav links
  assets/
    wholesale.js                     — All client JS (status check, price fetch, UI)
    wholesale.css                    — All storefront styles

prisma/
  schema.prisma                      — SQLite schema (String fields for enum-like values)
```

## Checkout UI Extension (Step 6) — PARKED (Plus-only), replaced by cart-notice block

> **PARKED 2026-06-23 in `_disabled_extensions/wholesale-checkout/`.** It targets
> `purchase.checkout.block.render` (the checkout page), and adding app blocks to checkout is a
> **Shopify Plus–only** feature — this store is **not** on Plus ([[project-not-shopify-plus]]),
> so the block can't be placed (the checkout editor shows "no blocks available", including on the
> order-status page, which uses a different target the block doesn't declare). It was advisory
> only anyway (can't hard-block an order).
>
> **Replacement (works on any plan):** the **cart-page** theme block
> `extensions/wholesale-ui/blocks/wholesale-cart-notice.liquid` ("Wholesale Cart Notice") shows
> the same minimum-order-not-met warning + free-shipping progress bar, placed on the `cart`
> template in the theme editor. That is the live path for the minimum-order warning.
>
> The extension is still in version `cwandt-wholesale-2` on the store but unplaceable; the next
> `shopify app deploy` will drop it from the app version. To revive it, move it back into
> `extensions/` — only worth it if the store upgrades to Shopify Plus.

`_disabled_extensions/wholesale-checkout/` — renders a warning block in the checkout if a wholesale
customer's cart is below the configured minimum order value.

**Customer detection**: reads the `wholesale.status` customer metafield set by the app
(namespace `"wholesale"`, key `"status"`, value `"approved"` or `"inactive"`). This metafield
is written by `app.applications.tsx` (on approve) and `app.customers.tsx` (on approve /
suspend / reject). The extension TOML declares the namespace/key so `useAppMetafields()` can
read it without a network call.

**Minimum value**: configured by the merchant in the Shopify checkout editor via an extension
setting (`minimum_order_value`). Must be kept in sync with the value in the app's Pricing Rules.

**Cannot block checkout**: Checkout UI Extensions are advisory only — they show warnings but
cannot prevent a customer from completing an order. For hard blocking, a Shopify Functions
Order Validation function would be needed (deferred).

**MOQ check**: structure is in place (commented out) and will activate when CMS sync (Step 9)
populates `moq` values on variant metafields.

**Important setup step (historical / Plus only)**: The extension would be added to the checkout in
Shopify Admin → Settings → Checkout → Customize. On a non-Plus store this is unavailable; use the
`wholesale-cart-notice` cart-page block instead (see the PARKED note above).

## Delivery Customization Function (Step 8)

> **REBUILT & ENABLED (2026-06-23).** Re-scaffolded with `shopify app generate extension
> --template delivery_customization --flavor typescript` on CLI **3.94.3**, which produces a
> modern JS function: `type = "function"`, target `cart.delivery-options.transform.run`, export
> `cart-delivery-options-transform-run`, `@shopify/shopify_function` v2, and an **empty**
> `[extensions.build].command = ""` so the CLI's native esbuild→Javy pipeline builds it (no more
> recursive `npm run build` deadlock). `npm run build` produces `dist/function.wasm`; `npm test`
> runs 3 vitest integration tests that build the wasm and validate I/O against the schema.
>
> The old parked copy (`_disabled_extensions/wholesale-shipping/`, old `delivery_customization`
> type with the recursive build) has been **deleted** — superseded by this one.

`extensions/wholesale-free-shipping/` — hides all shipping options that cost > $0 for approved
wholesale customers with a US shipping address. Non-wholesale buyers and non-US addresses
see normal shipping rates unaffected. Logic in `src/cart_delivery_options_transform_run.ts`;
input query in the sibling `.graphql`. US is checked per delivery group via
`deliveryAddress.countryCode === CountryCode.Us`.

**Customer detection**: reads the same `wholesale.status` customer metafield as the checkout
extension. The metafield is written exclusively by `syncCustomerToShopify()`
(`app/lib/enrollment.server.ts`), which runs on every enrollment and every
status/type/minimum change made in the app.

**Auto-activation**: `shopify.server.ts` `afterAuth` calls `deliveryCustomizationCreate` on
OAuth completion. It checks for an existing record first to avoid duplicates, and no-ops
silently if the function isn't deployed yet (safe to call on every re-auth).
**Requires the `read/write_delivery_customizations` scopes** (added to shopify.app.toml
2026-07-15) — before that, activation failed silently inside its try/catch on every auth
and the function was never live. Verify activation after any fresh install:
`deliveryCustomizations` query should list "Wholesale Free Shipping" enabled.

**REQUIRED SETUP — must do before testing:**
1. In Shopify Admin → Settings → Shipping and delivery → Manage rates: add a **$0 shipping
   rate** named "Wholesale Free Shipping" for the US zone. Without this rate, the function
   will hide ALL shipping options and the checkout will stall with no rates available.
2. Deploy the function so it exists in the store: `shopify app deploy` (or it builds + uploads
   during `shopify app dev`). On the next OAuth, `afterAuth` → `enableWholesaleShippingFunction`
   finds it by handle `wholesale-free-shipping` and creates the delivery customization record.
   (Build no longer needs any manual step — `dist/function.wasm` is produced natively by the CLI.)

**Scope of "free"**: US only. International wholesale orders see normal rates. If CW&T wants
free international wholesale shipping in the future, change the `isUS` check in `src/run.ts`.

## App Proxy

Shopify routes `https://cwandt.com/apps/wholesale/*` (store `thehundredthmonkey.myshopify.com`)
→ app server `/app-proxy/*`.
`logged_in_customer_id` in the query string is HMAC-signed by Shopify — safe to trust after
`authenticate.public.appProxy()` verifies the signature.

## Customer ID Format

`shopifyCustomerId` is stored as the **numeric string** (e.g. `"6789012345"` from `legacyResourceId`)
everywhere. When calling Admin GraphQL, construct the GID:
`gid://shopify/Customer/${customer.shopifyCustomerId}`

## SQLite → Postgres (two-schema setup, 2026-07-15)

Local dev stays on SQLite (`prisma/schema.prisma` + `prisma/migrations/`).
Production uses **`prisma/production/schema.prisma`** (provider `postgresql`)
with its own `prisma/production/migrations/` (baseline `0_init` generated via
`prisma migrate diff`, includes the PricingProfile seed rows). The Dockerfile
generates the client and runs `migrate deploy` with
`--schema prisma/production/schema.prisma`; `DATABASE_URL` comes from Fly
secrets. **Any model change must be made in BOTH schema files**, with a new
production migration generated via `prisma migrate diff --from-schema-datamodel
<old copy> --to-schema-datamodel prisma/production/schema.prisma --script`.

---

## Honest Risk Assessment — What Will Break on First Real Store Connection

Reviewed 2026-05-12. Issues are ordered by likelihood of causing real problems.

### HIGH — Will definitely need attention

**1. ~~`shopify.app.toml` placeholders not filled in~~ — RESOLVED**
`client_id` and `dev_store_url` are populated; dev URLs are auto-managed by
the CLI (`automatically_update_urls_on_dev = true`). Production
`application_url`/`redirect_urls` still need setting at deploy time.

**2. Theme CSS selectors may not match**
`wholesale-price.liquid` hides retail prices with:
```css
.price, .price__regular, .price__sale, .price--main,
.price-item--regular, .price-item--sale,
[class*="product__price"], [class*="ProductPrice"]
```
These cover Dawn (Shopify's default theme). If CW&T uses a custom theme with different class
names, retail prices will show through. Inspect the theme's price element classes and add
selectors to `wholesale-price.liquid` as needed.

**3. `wholesale-badge.liquid` must be added to the header**
The `<meta name="wh-customer">` tag that `wholesale.js` reads synchronously comes from this
block. If a merchant forgets to add it to their header section, `wholesale.js` will always
read content="" (absent meta = no tag) and treat everyone as non-wholesale. The price block
will never activate. This is the most operationally risky setup step.

**4. Webhook registration only runs on OAuth (`afterAuth`)**
Webhooks are registered in the `afterAuth` hook. If the app was installed before these webhooks
were added to `shopify.server.ts`, they won't be active until the merchant re-installs or
re-authorizes. During initial setup this is fine (OAuth flow runs), but worth knowing for
future webhook additions.

### MEDIUM — Functional gaps that will surface in testing

**5. `variant:change` event coverage**
`wholesale.js` listens for the `variant:change` custom event (dispatched by Dawn and some
other themes). Themes that don't dispatch this event will not update prices when the user
switches variants — the fallback `[name="id"]` change listener covers most cases, but
Ajax-driven variant selectors (without DOM form updates) won't trigger it.

**6. ~~Volume tier discount has no cap~~ — FIXED (2026-05-12)**
`applyVolumeTier` now loads `WholesaleSettings.maxDiscountPercent` (default 70%) and caps
the combined discount at that value via `Math.min`. Configurable in Settings → Pricing Policy.
Zod validation (`z.coerce.number().gt(0).max(100)`) on all discount and order minimum fields
in `app.pricing.tsx` and `app.settings.tsx` prevents nonsensical values from persisting.

**7. `qty` for volume tiers is per-product, not cart total**
The `qty` passed to the App Proxy comes from the product form quantity input.
Volume tier discounts therefore apply per-product quantity shown on the product page,
not the total cart quantity. Behavior may differ from what merchants expect.

**8. ~~`CUSTOMERS_UPDATE` webhook auto-approves~~ — REMOVED (2026-07-10)**
Customer webhooks no longer enroll anyone. Hand-tagging a customer in Shopify
Admin does nothing (the tag is rewritten to match DB state on the next
webhook). Enrollment happens only via the app's Customers page or application
approval. See "Customer Account Architecture" above. The behavioral change to
communicate to staff: **tagging in Admin no longer onboards a wholesale
customer — use the app.**

### LOW — Not bugs, but worth knowing

**9. Storefront API public access**
`authenticate.public.appProxy()` provides a Storefront API client that uses the shop's
public storefront token. Product prices are publicly accessible through the Storefront API —
this works without explicit Storefront API scopes. Should be fine out of the box.

**10. SQLite enum values are not DB-enforced**
Status fields (`"PENDING"`, `"APPROVED"`, etc.) are plain strings — SQLite does not enforce
valid values. A typo like `"APPOVED"` would persist silently. Consider adding Zod validation
at action boundaries before Step 10 polish.

### Bugs Fixed in Review (2026-05-12)

- **`app.customers.tsx` — tags replacement bug**: `customerUpdate` mutation was setting
  `tags: ["wholesale"]` which REPLACES all existing customer tags. Fixed to fetch existing
  tags first and append `"wholesale"` only if not already present.

- **`app.customers.tsx` — Select uncontrolled**: `onChange={() => {}}` caused the status
  Select to visually revert after every change, making the form unreliable. Fixed by
  extracting each row to a `CustomerRow` component with `useState(customer.status)` for
  per-row state.

---

## CMS Integration (Step 9)

CMS: Django app at `cms.cwandt.com` (DreamHost VPS: `cwandt@vps52023.dreamhostps.com`).
Repo: `github.com/cheewee2000/cwandt-cms` (private, READ ONLY).

CMS already has `apps/wholesale/` with `WholesaleVariant` model (wholesale_price,
distributor_price, moq, upc, status). The ONLY planned change to the CMS is adding:

```
GET /api/wholesale/variants/   (bearer token auth)
```

Wire via env vars: `CMS_BASE_URL` and `CMS_API_TOKEN` (already read in `cms-client.server.ts`).
Do not make any other CMS changes until explicitly instructed.
