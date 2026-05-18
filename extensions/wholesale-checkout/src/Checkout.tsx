import {
  reactExtension,
  Banner,
  Text,
  useCartLines,
  useCustomer,
  useAppMetafields,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension(
  "purchase.checkout.block.render",
  () => <WholesaleCartValidation />
);

function WholesaleCartValidation() {
  const customer = useCustomer();
  const cartLines = useCartLines();

  // wholesale.status: set by the app on approve/suspend/reject.
  const statusMetafields = useAppMetafields({ namespace: "wholesale", key: "status" });
  const wholesaleStatus = statusMetafields[0]?.metafield?.value;

  // wholesale.minimum_order_value: per-customer override (dollars as string), written by
  // app.customers.tsx / app.distributors.tsx when a custom minimum is saved.
  const minMetafields = useAppMetafields({ namespace: "wholesale", key: "minimum_order_value" });
  const perCustomerMin = minMetafields[0]?.metafield?.value;

  // wholesale.global_minimum_order_value: shop-level metafield written by app.pricing.tsx
  // whenever the global minimum is saved. No manual checkout editor sync needed.
  const globalMinMetafields = useAppMetafields({
    namespace: "wholesale",
    key: "global_minimum_order_value",
    ownerType: "shop",
  });
  const globalMin = globalMinMetafields[0]?.metafield?.value;

  if (!customer) return null;
  if (wholesaleStatus !== "approved") return null;

  // Per-customer override > global shop metafield > hardcoded fallback.
  const minValueDollars = perCustomerMin
    ? Number(perCustomerMin)
    : Number(globalMin ?? 500);

  const cartTotalDollars = cartLines.reduce((sum, line) => {
    return sum + parseFloat(line.cost.totalAmount.amount);
  }, 0);

  const errors: string[] = [];

  if (cartTotalDollars < minValueDollars) {
    const remaining = (minValueDollars - cartTotalDollars).toFixed(2);
    errors.push(
      `Wholesale orders require a minimum of $${minValueDollars.toFixed(2)}. ` +
        `Add $${remaining} more to continue.`
    );
  }

  // ── MOQ check (activates when CMS sync populates moq variant metafields) ───
  // for (const line of cartLines) {
  //   const moq = Number(line.merchandise.product?.metafield?.value ?? 1);
  //   if (line.quantity < moq) {
  //     errors.push(`${line.merchandise.title}: minimum order quantity is ${moq} units.`);
  //   }
  // }

  if (errors.length === 0) return null;

  return (
    <Banner status="warning" title="Wholesale order requirements not met">
      {errors.map((error, idx) => (
        <Text key={idx}>{error}</Text>
      ))}
    </Banner>
  );
}
