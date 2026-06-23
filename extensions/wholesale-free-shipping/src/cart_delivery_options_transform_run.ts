/**
 * Shopify Function: Wholesale Free Shipping (cart.delivery-options.transform.run)
 *
 * Hides every shipping option that costs more than $0 when the buyer is:
 *   - A logged-in customer whose `wholesale.status` metafield === "approved", AND
 *   - Shipping to a US address (checked per delivery group).
 *
 * Non-wholesale buyers and non-US delivery groups are left untouched.
 *
 * REQUIRED SETUP: a $0 shipping rate named "Wholesale Free Shipping" must exist in
 * Shopify Admin → Settings → Shipping and delivery → Manage rates for the US zone.
 * Without it this function hides ALL options and checkout stalls with no rates.
 */
import { CountryCode } from "../generated/api";
import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartDeliveryOptionsTransformRunResult = {
  operations: [],
};

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput,
): CartDeliveryOptionsTransformRunResult {
  const isWholesale =
    input.cart.buyerIdentity?.customer?.metafield?.value === "approved";

  if (!isWholesale) {
    return NO_CHANGES;
  }

  const operations: Operation[] = [];

  for (const group of input.cart.deliveryGroups) {
    // Only apply free shipping to US destinations; other groups keep normal rates.
    if (group.deliveryAddress?.countryCode !== CountryCode.Us) {
      continue;
    }

    for (const option of group.deliveryOptions) {
      if (parseFloat(option.cost.amount) > 0) {
        operations.push({
          deliveryOptionHide: { deliveryOptionHandle: option.handle },
        });
      }
    }
  }

  return { operations };
}
