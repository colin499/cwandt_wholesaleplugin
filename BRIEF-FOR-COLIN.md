# Wholesale restructure — brief for Colin

_From Taylor, 2026-07-12. Covers work done July 9–12 in both repos. Please read
before pushing to either repo — there's rebase-worthy change in both._

## TL;DR

I picked the wholesale project back up, did significant restructuring with
Claude Code, and made some architecture decisions as owner. Nothing you built
was thrown away — most of it got consolidated. The go-live gate is still yours.
The biggest behavioral change: **tagging a customer `wholesale` in Shopify
Admin no longer does anything** — the app is now the only way to enroll.

---

## Wholesale plugin (`cwandt_wholesaleplugin`)

All on branch **`feat/unified-customers`** (not merged to main yet). Verified
end-to-end against the dev store.

**Customer architecture — one source of truth.** The local `WholesaleCustomer`
row is authoritative. Shopify tags and the `wholesale.status` metafield are
write-only projections, emitted by one function (`syncCustomerToShopify` in
`app/lib/enrollment.server.ts`). Customer webhooks reconcile instead of enroll:
hand-edits to managed tags in Admin are detected and rewritten to match the DB,
in both directions (self-healing). The old auto-approve-at-50%-via-tag path is
gone — it bypassed the review flow and never revoked access on untag.

**Pages merged.** Customers + Distributors are one Customers page now, with
type tabs (Wholesale / Distributor / B2B), Shopify-wide customer search with
one-click enroll, per-row type changes, and an Import & Reconcile card
(backfills pre-app tagged customers; heals projection drift; dry-run default).

**Pricing profiles.** New `PricingProfile` table (`pp_wholesale`,
`pp_distributor`, `pp_b2b`), editable under Pricing → Pricing Profiles.
`discountPercent` on the customer is now a nullable override (null = profile
rate). Your `isDistributor ? 50 : 50` question is now a form field.

**Webhooks fixed.** `webhookSubscriptions` on the dev store was empty — the
API-registered webhooks (registered fire-and-forget in `afterAuth`) never took
effect, so CUSTOMERS_* never fired. All topics moved to `shopify.app.toml`
(relative URIs follow `application_url` across tunnel changes). Also added the
three GDPR compliance handlers (data_request / customers redact / shop redact).

**Protected customer data.** The app had never been granted protected customer
data access in the Partner Dashboard — every Customer read/write was failing
with ACCESS_DENIED. Now configured (dev-store access; no App Store review
needed for single-merchant).

**Docs.** `CLAUDE.md` and `REMAINING.md` updated to match all of the above.
Notably: your "placeholders not filled" and "webhook auto-approves" risk items
are resolved/removed, and the repo moved out of iCloud (now
`~/Development/cwandt-wholesale-plugin`).

## CMS (`cwandt-cms`) — deployed, live at v0.14.0

I'm authorizing CMS changes directly now (I built the wholesale module
originally; the "CMS is READ ONLY" note in the plugin's CLAUDE.md was your
guardrail, not a constraint on the codebase).

**Decision: `WholesaleVariant` rows are the source of truth for what is
wholesale.** The "Wholesale 50%" / "Wholesale 30%" Shopify collections are
legacy — they only feed BSS B2B now and retire when BSS does. The one-time
seed command's job is replaced by UI:

**New Wholesale UI** (sidebar → Wholesale): the linesheet list, an
"Add product to wholesale" flow (search published products, per-variant
prices prefilled at the two historical tiers — 50%/40% and 70%/60% of retail —
editable, MOQ per variant), and per-row Remove. Your API endpoint is unchanged.

**Heads-up:** your GitHub Actions auto-deploy works great — which also means
`git push` to CMS main is a production deploy. Pull before working; Taylor and
Claude have pushed (`c71c083`, `a3e0199`, `72c73c7`; version now 0.14.1).

**Your gunicorn ghost is exorcised** (`72c73c7`): deploys were silently
half-failing — `pkill` can't see other processes in this VPS's SSH sessions
(procps fails), so the old gunicorn kept :8099, the new one died with
"Connection in use", and the site served stale code while the deploy reported
success. That's almost certainly what your `0fe06bf` restart fix was chasing.
deploy.sh now kills the port-holder via `fuser` (which works there) and fails
loudly if gunicorn isn't listening afterwards.

## Pricing is now CMS-driven end to end ("Phase A", done 2026-07-12)

Wholesale availability = has CMS row AND not in
`custom.wholesale_hidden_variants` metafield AND Shopify product Active —
enforced by every App Proxy endpoint including backorder creation (which now
prices from the CMS and enforces MOQ, instead of a blanket percentage).
**The flat 50%-off fallback is dead**: not in the CMS = not wholesale — no
price, no card label, not on the line sheet, not backorderable. On PDPs the
storefront JS reveals retail pricing for non-program products (the price
block's CSS used to hide retail unconditionally, which would have left no
price at all).

Your GLOBAL_DISCOUNT / VOLUME_TIER / PRODUCT_OVERRIDE pricing-rule system is
retired — removed from resolution and from the admin UI, along with the
Settings "Pricing Policy" max-discount cap. The PricingRule table and
maxDiscountPercent column still exist but nothing reads them (future cleanup
migration). PRODUCT_OVERRIDE was never read by anything, for what it's worth.

## Planned next (not built yet)

- CMS API endpoint to apply the same hidden-variants exclusion the sheet uses
  (until then, hidden variants are excluded app-side at price time — same
  result, the metafield is read from Shopify directly).
- MOQ display + enforcement (real MOQs to be entered; all 115 rows currently
  sit at the seeded default of 5).
- Pack increments (e.g. Time Since Launch 25-pack) via a future
  `order_increment` field.
- An orderable storefront linesheet (quantities → draft order w/ net terms),
  eventually replacing the Google Sheet for buyers.

## Data archaeology + cleanup plan (audit tool: `manage.py audit_wholesale`)

A read-only CMS audit command now exists for pre-go-live data checks. Its
first production run (2026-07-13, 98 findings) surfaced, among other things,
the **`W-*` legacy wholesale catalog**: ~77 hidden live-store products
(SKUs `W-…`, titles ending `*`, CMS status `wholesale`) implementing the
pre-BSS wholesale program as separate pack-size products. Verified: nothing
in the new system references them (0 in the wholesale table, 0 in the app
cache). Cleanup is deferred until after the build; their pack-size SKU
suffixes (`-2/-5/-10/-25`) are the design input for real MOQs and the pack
feature. **Cutover checklist gains: archive the `W-*` products on the live
store + retire them in the CMS.** Also pending review: 14 wholesale rows on
retired variants, and 8 duplicate-SKU groups (the KUYA pattern — a hidden
retired twin plus a visible stocked twin sharing one SKU).

## Open items where your input is wanted

1. **Distributor rate** — still 50% like wholesale; when decided, it's an edit
   in Pricing → Pricing Profiles, no deploy.
2. **Go-live gate** — still yours. New landmines found for the checklist:
   - Live theme checks `customer.tags contains 'Wholesale'` (capital W); the
     app writes lowercase `wholesale`. Case-sensitive — must align at cutover.
   - Run Import & Reconcile after installing on live (webhooks only cover
     events from install forward).
   - Staff workflow change to communicate: onboarding via Admin tags is dead.
   - Your existing notes ($0 shipping rate before function deploy, etc.) still
     apply.
3. **CMS smoke test** is at 17/19 — Project list and Launch calendar 404
   locally, and that pre-dates our work. Possibly related to the June core
   changes or local migrations; worth a look when you're in there.

Questions → Taylor. The full history is in both repos' commit messages, which
are unusually detailed right now.
