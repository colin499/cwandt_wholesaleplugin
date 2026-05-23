/**
 * Shopify Function: Wholesale Free Shipping (Delivery Customization)
 *
 * Hides all shipping options that cost more than $0 when the buyer is:
 *   - A logged-in customer with wholesale.status metafield === "approved"
 *   - Shipping to a US address
 *
 * REQUIRED SETUP: A $0 shipping rate named "Wholesale Free Shipping" must exist
 * in Shopify Admin → Settings → Shipping and delivery → Manage rates.
 * Without it, this function will hide ALL rates and the checkout will stall.
 *
 * Input types are manually defined here to match the query in run.graphql.
 * Run `shopify app function build` to compile to WASM; `shopify app dev` builds
 * automatically during development.
 */

// ── Input types (mirror run.graphql) ──────────────────────────────────────────

type RunInput = {
  cart: {
    buyerIdentity: {
      countryCode: string | null;
      customer: {
        metafield: { value: string } | null;
      } | null;
    } | null;
  };
  deliveryGroups: Array<{
    id: string;
    deliveryOptions: Array<{
      handle: string;
      title: string;
      cost: { amount: string; currencyCode: string };
    }>;
  }>;
};

// ── Output types ──────────────────────────────────────────────────────────────

type HideOperation   = { hide:   { deliveryOptionHandle: string } };
type RenameOperation = { rename: { deliveryOptionHandle: string; title: string } };
type MoveOperation   = { move:   { deliveryOptionHandle: string; index: number } };
type Operation = HideOperation | RenameOperation | MoveOperation;

type FunctionRunResult = { operations: Operation[] };

// ── Function entrypoint ───────────────────────────────────────────────────────

export function run(input: RunInput): FunctionRunResult {
  const buyerIdentity = input.cart.buyerIdentity;
  const isUS          = buyerIdentity?.countryCode === "US";
  const wholesaleStatus = buyerIdentity?.customer?.metafield?.value;
  const isWholesale   = wholesaleStatus === "approved";

  // Only apply to approved wholesale customers with a US shipping address.
  // All other buyers see the store's normal shipping rates unmodified.
  if (!isWholesale || !isUS) {
    return { operations: [] };
  }

  // Hide every option that carries a cost — keep only $0 rates.
  // The $0 "Wholesale Free Shipping" rate in Shopify Admin is the one that remains.
  const operations: Operation[] = [];
  for (const group of input.deliveryGroups) {
    for (const option of group.deliveryOptions) {
      if (parseFloat(option.cost.amount) > 0) {
        operations.push({ hide: { deliveryOptionHandle: option.handle } });
      }
    }
  }

  return { operations };
}
