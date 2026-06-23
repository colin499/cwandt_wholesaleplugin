# PARKED — Checkout UI extension (Shopify Plus only)

**Parked 2026-06-23.** This Checkout UI extension ("Wholesale Cart Validation") targets
`purchase.checkout.block.render`. Placing app blocks into the checkout is a **Shopify Plus–only**
capability, and this store is **not** on Plus — so the block cannot be added in
Settings → Checkout → Customize (the editor shows "no blocks available", including on the
order-status page, which uses a different target this block doesn't declare).

It was advisory-only regardless (a Checkout UI extension can warn but cannot hard-block an order).

## What replaces it (works on any plan)

The minimum-order-not-met warning + free-shipping progress bar is handled by the **cart-page**
theme block instead:

  `extensions/wholesale-ui/blocks/wholesale-cart-notice.liquid`  ("Wholesale Cart Notice")

Add it on the `cart` template in the theme editor. No Plus required.

## To revive this extension

Only worth it if the store upgrades to Shopify Plus. Move this directory back to
`extensions/wholesale-checkout/` and run `shopify app deploy`. It still detects the customer via
the `wholesale.status` metafield and reads `wholesale.minimum_order_value` per-customer.
