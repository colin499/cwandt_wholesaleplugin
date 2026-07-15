/**
 * Shopify Function: Wholesale Free Shipping (cart.delivery-options.transform.run)
 *
 * For approved wholesale buyers (customer metafield wholesale.status ===
 * "approved") shipping to a US address:
 *   - Normal orders: hides every option that costs more than $0 → they see
 *     only the free wholesale rate.
 *   - Orders containing any product tagged `no-free-shipping` (big/heavy
 *     items, e.g. Superlocal, Time Since Launch): hides every $0 option
 *     instead → they pay real freight. One heavy item disqualifies the whole
 *     shipment, since rates apply per shipment, not per line.
 *
 * For everyone else (retail, or wholesale shipping outside the US): hides the
 * wholesale-only rate (matched by title) so retail buyers can never select
 * the $0 wholesale rate. Other rates are left untouched.
 *
 * REQUIRED SETUP: a $0 shipping rate named EXACTLY "Wholesale Free Shipping"
 * must exist in Shopify Admin → Settings → Shipping and delivery for the US
 * zone. Without it this function hides ALL options for wholesale buyers and
 * checkout stalls with no rates.
 */
import { CountryCode } from "../generated/api";
import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
  Operation,
} from "../generated/api";

const WHOLESALE_RATE_TITLE = "Wholesale Free Shipping";

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput,
): CartDeliveryOptionsTransformRunResult {
  const isWholesale =
    input.cart.buyerIdentity?.customer?.metafield?.value === "approved";

  const operations: Operation[] = [];

  if (!isWholesale) {
    // Retail buyers must never see the wholesale-only $0 rate.
    for (const group of input.cart.deliveryGroups) {
      for (const option of group.deliveryOptions) {
        if (option.title === WHOLESALE_RATE_TITLE) {
          operations.push({
            deliveryOptionHide: { deliveryOptionHandle: option.handle },
          });
        }
      }
    }
    return { operations };
  }

  // Any `no-free-shipping`-tagged product in the cart disqualifies the whole
  // order from free shipping.
  const hasHeavyItem = input.cart.lines.some(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      line.merchandise.product.noFreeShipping,
  );

  for (const group of input.cart.deliveryGroups) {
    // Free shipping is US-only; other destinations keep normal rates. (The
    // wholesale rate lives in the US zone, so it can't appear elsewhere.)
    if (group.deliveryAddress?.countryCode !== CountryCode.Us) {
      continue;
    }

    for (const option of group.deliveryOptions) {
      const cost = parseFloat(option.cost.amount);
      const hide = hasHeavyItem ? cost === 0 : cost > 0;
      if (hide) {
        operations.push({
          deliveryOptionHide: { deliveryOptionHandle: option.handle },
        });
      }
    }
  }

  return { operations };
}
