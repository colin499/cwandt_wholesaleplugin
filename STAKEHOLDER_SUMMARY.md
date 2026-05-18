# CW&T Wholesale App — Plain English Summary

**What this is, what it replaces, and what it costs to run.**

---

## What We're Building

A custom wholesale portal for CW&T's Shopify store.

When a wholesale buyer (a retailer, distributor, or trade account) visits cwandt.com and logs into their account, they see a completely different experience from a regular retail customer:

- **Discounted prices** — their account shows wholesale pricing (e.g. 40% off retail) automatically, with no manual coupon codes
- **A "Wholesale" badge** in the header so they always know they're in wholesale mode
- **Access to a live line sheet** — a printable/downloadable catalog showing all available products with wholesale prices, SKUs, and quantities
- **The ability to order out-of-stock items** — wholesale customers can place backorders on items that retail customers see as "sold out"
- **Net payment terms** — they can choose to pay on Net 30 or Net 60 terms instead of paying by card at checkout
- **Minimum order enforcement** — the cart won't let them check out until they've met the minimum order value (e.g. $500)
- **Free shipping** — US wholesale orders ship free automatically

Retail visitors and logged-out users see none of this. Everything is layered invisibly on top of the existing website — no separate wholesale website, no second Shopify store.

---

## What It Replaces

CW&T currently pays for a third-party B2B wholesale app from the Shopify App Store. That app handles some of these features but:

- Costs a recurring monthly subscription fee
- Cannot be customized to our exact workflow
- Does not connect to the CW&T internal CMS (the tool we built to manage inventory, costs, and projections)
- Requires us to manage wholesale pricing in two separate places

This custom app replaces it entirely with something we own, can modify freely, and that talks directly to our existing inventory system.

---

## How It Connects to Our Inventory System

CW&T already has a custom CMS (cms.cwandt.com) that tracks inventory, assembly, purchase orders, and wholesale pricing. This app connects to it so that:

- **Inventory is always current** — when stock changes in the CMS, Shopify updates automatically
- **Wholesale prices are always current** — the CMS is the single source of truth for pricing; the storefront reads from it
- **Orders are reflected** — when a wholesale order is placed, the CMS sees it and can track it alongside retail orders

No more updating prices in two places. No more manual inventory reconciliation.

---

## What It Does NOT Do

To keep this focused and maintainable, this app does not:

- Replace your existing Shopify theme or storefront design
- Build a separate website or login page
- Handle retail promotions, gift cards, or loyalty programs
- Require any changes to how retail customers shop

---

## Who Manages It

Once installed, CW&T staff manage the wholesale program from a private admin panel inside Shopify. From there they can:

- **Review and approve** wholesale account applications submitted through the website
- **Set the discount percentage** applied to all wholesale customers
- **Configure minimum order values**
- **View wholesale order history** and payment terms

No developer required for day-to-day operation.

---

## What It Costs to Run

This app is self-hosted. There is no monthly software license.

| Item | Cost |
|---|---|
| Shopify app subscription | **$0** — private app, installed on one store |
| Hosting (Fly.io) | **~$5–10/month** — one small server, scales with traffic |
| Database (Postgres via Fly.io) | **~$5/month** — managed, backed up automatically |
| Domain / SSL | **$0** — handled by Fly.io |
| **Total monthly** | **~$10–15/month** |

By comparison, most B2B Shopify apps on the App Store cost $50–$200/month for comparable features.

**One-time build cost** covers development time to reach the features listed in this document. After that, ongoing cost is hosting only.

---

## Current Status

Phase 1 is underway. The app skeleton, database, and admin interface are scaffolded. Next steps are:

1. Build the customer tag check and wholesale price display
2. Wire in the CMS pricing sync
3. Build the line sheet
4. Set up the checkout rules (minimums, net terms, free shipping)
5. Connect to the dev store for testing

Nothing is connected to the live store yet. All development is happening locally until we're ready to test.

---

*Questions? Ask the development team.*
