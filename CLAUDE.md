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

**iCloud sync caveat:** this repo lives under `~/Documents/CW&T`, covered by iCloud "Desktop &
Documents" sync. Sync periodically creates `" 2"` duplicate binaries inside `node_modules` (e.g.
`@esbuild/.../bin/esbuild 2`) and can corrupt the originals, breaking builds confusingly.
**Strongly consider moving the repo out of the synced folder** (or excluding `node_modules`).

### Troubleshooting "the dev server is broken"

| Symptom | Cause | Fix |
|---|---|---|
| Frozen at "Preparing dev preview"; cloudflared log loops `Unauthorized: Tunnel not found` | Stale bundled cloudflared rejected by Cloudflare edge | `brew install cloudflared` (already wired via `SHOPIFY_CLI_CLOUDFLARED_PATH`); Ctrl+C and re-run `./dev-start.sh` |
| Preview page says `Invalid path /…` | `shopify.web.toml` not `frontend`, or `vite.config.ts` hardcodes the port | Restore the two invariants above; restart dev |
| An extension/function build hangs silently (proc alive, 0% CPU, no output) | `shopify app function build` with a recursive `build.command` deadlocking on the `.build-lock` dir | The shipping function is parked in `_disabled_extensions/`; see Delivery Customization below |
| `Host version X does not match binary Y`, or weird esbuild failures | iCloud sync corrupted an esbuild binary | `find node_modules -name "* 2"`, then `npm ci`; move repo off iCloud |

## Build Status

- [x] Step 1: App scaffolded (Remix, TypeScript, Shopify CLI)
- [x] Step 2: Prisma schema (SQLite, 7 models), migrations run, db.server.ts
- [x] Step 3: `wholesale-customer.server.ts` middleware, login delay bug fix (3-layer)
- [x] Step 4: App Proxy route, Theme App Extension blocks + assets
- [x] Step 5: Out-of-stock / backorder (Draft Order API bypass)
- [x] Step 6: Cart validation (min cart value — Checkout UI Extension)
- [x] Step 7: HTML line sheet (client-side print CSS + html2pdf.js)
- [~] Step 8: Shipping rule (Shopify Functions Delivery Customization) — code written, but the
      function **never built** and is currently DISABLED (parked in `_disabled_extensions/`). See below.
- [ ] Step 9: CMS sync (GET /api/wholesale/variants/ endpoint on cms.cwandt.com)
- [ ] Step 10: Admin dashboard polish

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
- Do NOT connect to the live Shopify store (`cw-and-t.myshopify.com`) until explicitly told
- All storefront UI via Theme App Extensions only — no direct theme file edits
- The only planned CMS change: add one read-only endpoint (`GET /api/wholesale/variants/`)

## File Map

```
app/
  db.server.ts                       — PrismaClient singleton (hot-reload safe)
  shopify.server.ts                  — Shopify app config, webhooks, auth
  lib/
    wholesale-customer.server.ts     — Core middleware (getWholesaleSession, pricing math)
    cms-client.server.ts             — CMS API client stub (Step 9)
  routes/
    app._index.tsx                   — Dashboard
    app.customers.tsx                — Wholesale customer list + status + per-customer min order value
    app.distributors.tsx             — Distributor account management (create, status, min order value)
    app.applications.tsx             — Application review (approve / reject)
    app.pricing.tsx                  — Pricing rules + order minimums
    app-proxy.$.tsx                  — App Proxy: /apps/wholesale/prices, /order-minimums
    webhooks.tsx                     — Shopify webhook handler

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

## Checkout UI Extension (Step 6)

`extensions/wholesale-checkout/` — renders a warning block in the checkout if a wholesale
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

**Important setup step**: The extension must be added to the checkout in Shopify Admin →
Settings → Checkout → Customize. Without adding the block, it renders nothing.

## Delivery Customization Function (Step 8)

> **CURRENTLY DISABLED.** This function is parked in `_disabled_extensions/wholesale-shipping/`
> (out of the `extensions/` scan path) because it never had a working build. Its
> `shopify.extension.toml` set `[extensions.build].command = "npm run build"`, and the npm
> `build` script is itself `shopify app function build` — so the build recursively re-invoked
> itself and deadlocked on the directory `.build-lock`, hanging the CLI forever at "Preparing
> dev preview". This CLI (3.73) requires an explicit build command and does NOT build JS
> functions natively, and the extension has no real toolchain (no Javy/bundler deps). To
> re-enable: move it back into `extensions/` AND set up a real JS→WASM build (bundle `src/run.ts`
> + Javy → `dist/function.wasm`) with a **non-recursive** build command. Everything else (admin
> app, `wholesale-ui`, `wholesale-checkout`) runs without it.

`extensions/wholesale-shipping/` — hides all shipping options that cost > $0 for approved
wholesale customers with a US shipping address. Non-wholesale buyers and non-US addresses
see normal shipping rates unaffected.

**Customer detection**: reads the same `wholesale.status` customer metafield as the checkout
extension. Metafield is written on every approve/suspend/reject in `app.customers.tsx` and
`app.applications.tsx`.

**Auto-activation**: `shopify.server.ts` `afterAuth` calls `deliveryCustomizationCreate` on
OAuth completion. It checks for an existing record first to avoid duplicates, and no-ops
silently if the function isn't deployed yet (safe to call on every re-auth).

**REQUIRED SETUP — must do before testing:**
1. In Shopify Admin → Settings → Shipping and delivery → Manage rates: add a **$0 shipping
   rate** named "Wholesale Free Shipping" for the US zone. Without this rate, the function
   will hide ALL shipping options and the checkout will stall with no rates available.
2. Set up a working JS→WASM build first (see the DISABLED note above) — the build does **not**
   work as-is and is NOT handled automatically by `shopify app dev` (it deadlocks). Once a
   non-recursive build command produces `dist/function.wasm`, move the extension back into
   `extensions/`.

**Scope of "free"**: US only. International wholesale orders see normal rates. If CW&T wants
free international wholesale shipping in the future, change the `isUS` check in `src/run.ts`.

## App Proxy

Shopify routes `https://cw-and-t.myshopify.com/apps/wholesale/*` → app server `/app-proxy/*`.
`logged_in_customer_id` in the query string is HMAC-signed by Shopify — safe to trust after
`authenticate.public.appProxy()` verifies the signature.

## Customer ID Format

`shopifyCustomerId` is stored as the **numeric string** (e.g. `"6789012345"` from `legacyResourceId`)
everywhere. When calling Admin GraphQL, construct the GID:
`gid://shopify/Customer/${customer.shopifyCustomerId}`

## SQLite → Postgres Migration

When deploying to Fly.io, change `schema.prisma` datasource provider to `"postgresql"` and
set `DATABASE_URL` to the Fly Postgres connection string. The String-based status fields work
in both databases. Run `prisma migrate deploy` in the Dockerfile (already configured).

---

## Honest Risk Assessment — What Will Break on First Real Store Connection

Reviewed 2026-05-12. Issues are ordered by likelihood of causing real problems.

### HIGH — Will definitely need attention

**1. `shopify.app.toml` placeholders not filled in**
Three placeholders must be replaced before `shopify app dev` works:
- `YOUR_CLIENT_ID_FROM_PARTNER_DASHBOARD`
- `YOUR_DEV_STORE.myshopify.com`
- `YOUR_APP_URL.fly.dev` (also in the `[app_proxy]` section)

Without these, OAuth will fail with cryptic errors.

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

**8. `CUSTOMERS_UPDATE` webhook auto-approves at default 40% discount**
`handleCustomerWebhook` in `webhooks.tsx` creates a `WholesaleCustomer` with
`status: "APPROVED"` and `discountPercent: 40` whenever a customer with the `wholesale`
tag is seen via webhook. This means manually tagging a customer in Shopify Admin bypasses
the application review flow and hardcodes 40% discount. Intentional, but the admin should
know this shortcut exists.

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
