import {
  extension,
  Banner,
  Text,
  Select,
} from "@shopify/ui-extensions/checkout";

export default extension("purchase.checkout.block.render", (root, api) => {
  const { cartLines, appMetafields, buyerIdentity, applyAttributeChange } = api;

  // Persists the customer's selection across re-renders triggered by subscriptions.
  let selectedTerms = "credit_card";

  function render() {
    root.removeChildren();

    const customer = buyerIdentity.customer.current;
    if (!customer) return;

    const statusMeta = appMetafields.current.find(
      (m) =>
        m.metafield?.namespace === "wholesale" &&
        m.metafield?.key === "status"
    );
    if (statusMeta?.metafield?.value !== "approved") return;

    // ── Minimum order warning ─────────────────────────────────────────────
    const perCustomerMin = appMetafields.current.find(
      (m) =>
        m.metafield?.namespace === "wholesale" &&
        m.metafield?.key === "minimum_order_value"
    )?.metafield?.value;

    const globalMin = appMetafields.current.find(
      (m) =>
        m.metafield?.namespace === "wholesale" &&
        m.metafield?.key === "global_minimum_order_value"
    )?.metafield?.value;

    const minValueDollars = perCustomerMin
      ? Number(perCustomerMin)
      : Number(globalMin ?? 500);

    const cartTotalDollars = cartLines.current.reduce((sum, line) => {
      return sum + parseFloat(line.cost.totalAmount.amount);
    }, 0);

    if (cartTotalDollars < minValueDollars) {
      const remaining = (minValueDollars - cartTotalDollars).toFixed(2);
      const message =
        `Wholesale orders require a minimum of $${minValueDollars.toFixed(2)}. ` +
        `Add $${remaining} more to continue.`;

      const banner = root.createComponent(Banner, {
        status: "warning",
        title: "Wholesale order requirements not met",
      });
      banner.appendChild(root.createComponent(Text, {}, message));
      root.appendChild(banner);
    }

    // ── Payment terms selector ────────────────────────────────────────────
    // Stored as order attribute `_payment_terms` so the webhook handler and
    // the admin order view can both read it.
    const select = root.createComponent(Select, {
      label: "Payment Terms",
      options: [
        { label: "Pay by card at checkout", value: "credit_card" },
        { label: "Net 30 — invoice due within 30 days", value: "net-30" },
        { label: "Net 60 — invoice due within 60 days", value: "net-60" },
      ],
      value: selectedTerms,
      onChange: (value: string) => {
        selectedTerms = value;
        void applyAttributeChange({
          key: "_payment_terms",
          type: "updateAttribute",
          value,
        });
      },
    });
    root.appendChild(select);
  }

  cartLines.subscribe(render);
  appMetafields.subscribe(render);
  buyerIdentity.customer.subscribe(render);
  render();
});
