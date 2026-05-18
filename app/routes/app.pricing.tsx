import { z } from "zod";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  BlockStack,
  FormLayout,
  TextField,
  Select,
  InlineStack,
  Banner,
  InlineError,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const CreateRuleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["GLOBAL_DISCOUNT", "VOLUME_TIER", "PRODUCT_OVERRIDE"]),
  discountPercent: z.coerce
    .number()
    .gt(0, "Discount must be greater than 0")
    .max(100, "Discount cannot exceed 100%"),
  minimumQuantity: z.coerce
    .number()
    .int("Minimum quantity must be a whole number")
    .positive("Minimum quantity must be positive")
    .nullable(),
});

const UpdateMinimumsSchema = z.object({
  minimumOrderValue: z.coerce
    .number()
    .min(0, "Minimum order value cannot be negative"),
  minimumOrderQuantity: z.coerce
    .number()
    .int("Minimum quantity must be a whole number")
    .positive("Minimum quantity must be positive")
    .nullable(),
});

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [rules, minimumConfig, settings] = await Promise.all([
    db.pricingRule.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.orderMinimumConfig.findFirst({ where: { active: true } }),
    db.wholesaleSettings.findFirst(),
  ]);

  return json({ rules, minimumConfig, maxDiscountPercent: settings?.maxDiscountPercent ?? 70 });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "create-rule") {
    const raw = {
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? ""),
      discountPercent: formData.get("discountPercent"),
      minimumQuantity: formData.get("minimumQuantity") || null,
    };

    const result = CreateRuleSchema.safeParse(raw);
    if (!result.success) {
      return json(
        { errors: result.error.flatten().fieldErrors },
        { status: 422 }
      );
    }

    await db.pricingRule.create({ data: result.data });
    return json({ ok: true });
  }

  if (intent === "toggle-rule") {
    const ruleId = String(formData.get("ruleId"));
    const rule = await db.pricingRule.findUnique({ where: { id: ruleId } });
    if (rule) {
      await db.pricingRule.update({
        where: { id: ruleId },
        data: { active: !rule.active },
      });
    }
    return json({ ok: true });
  }

  if (intent === "delete-rule") {
    await db.pricingRule.delete({
      where: { id: String(formData.get("ruleId")) },
    });
    return json({ ok: true });
  }

  if (intent === "update-minimums") {
    const raw = {
      minimumOrderValue: formData.get("minimumOrderValue"),
      minimumOrderQuantity: formData.get("minimumOrderQuantity") || null,
    };

    const result = UpdateMinimumsSchema.safeParse(raw);
    if (!result.success) {
      return json(
        { errors: result.error.flatten().fieldErrors },
        { status: 422 }
      );
    }

    const existing = await db.orderMinimumConfig.findFirst({ where: { active: true } });
    if (existing) {
      await db.orderMinimumConfig.update({ where: { id: existing.id }, data: result.data });
    } else {
      await db.orderMinimumConfig.create({ data: { ...result.data, active: true } });
    }

    // Write global minimum as a shop metafield so the checkout extension can
    // read it automatically — no manual sync via the checkout editor needed.
    try {
      const shopRes = await admin.graphql(`{ shop { id } }`);
      const shopData = await shopRes.json();
      const shopId = shopData.data?.shop?.id;
      if (shopId) {
        await admin.graphql(
          `#graphql
          mutation SetGlobalMinimum($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              metafields: [{
                ownerId: shopId,
                namespace: "wholesale",
                key: "global_minimum_order_value",
                value: String(result.data.minimumOrderValue),
                type: "number_decimal",
              }],
            },
          }
        );
      }
    } catch (err) {
      // Non-fatal — DB is source of truth; metafield write failure just means
      // checkout extension falls back to its hardcoded $500 default.
      console.error("[pricing] Failed to write global_minimum_order_value shop metafield:", err);
    }

    return json({ ok: true });
  }

  return json({ ok: true });
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const { rules, minimumConfig, maxDiscountPercent } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [minOrderValue, setMinOrderValue] = useState(
    String(minimumConfig?.minimumOrderValue ?? 500)
  );
  const [minOrderQty, setMinOrderQty] = useState(
    minimumConfig?.minimumOrderQuantity ? String(minimumConfig.minimumOrderQuantity) : ""
  );
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleType, setNewRuleType] = useState("GLOBAL_DISCOUNT");
  const [newRuleDiscount, setNewRuleDiscount] = useState("");
  const [newRuleMinQty, setNewRuleMinQty] = useState("");

  const globalRule = rules.find((r) => r.type === "GLOBAL_DISCOUNT" && r.active);

  // Field-level errors returned from the action
  const actionErrors =
    fetcher.data && "errors" in fetcher.data
      ? (fetcher.data.errors as Record<string, string[] | undefined>)
      : null;

  return (
    <Page title="Pricing Rules">
      <BlockStack gap="500">
        {!globalRule && (
          <Banner title="No active global discount" tone="warning">
            <Text as="p">
              Set a global discount rule so wholesale customers see discounted prices.
            </Text>
          </Banner>
        )}

        {/* Active rules summary */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Current Rules</Text>
            <Text as="p" tone="subdued">
              Maximum combined discount is capped at <strong>{maxDiscountPercent}%</strong>.
              Change this in Settings → Pricing Policy.
            </Text>
            <IndexTable
              resourceName={{ singular: "rule", plural: "rules" }}
              itemCount={rules.length}
              headings={[
                { title: "Name" },
                { title: "Type" },
                { title: "Discount" },
                { title: "Min Qty" },
                { title: "Status" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {rules.map((rule, idx) => (
                <IndexTable.Row id={rule.id} key={rule.id} position={idx}>
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="semibold">{rule.name}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {rule.type.replace(/_/g, " ")}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{rule.discountPercent}% off</IndexTable.Cell>
                  <IndexTable.Cell>{rule.minimumQuantity ?? "—"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={rule.active ? "success" : "info"}>
                      {rule.active ? "Active" : "Inactive"}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle-rule" />
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <Button size="slim" submit>
                          {rule.active ? "Disable" : "Enable"}
                        </Button>
                      </fetcher.Form>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="delete-rule" />
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <Button size="slim" tone="critical" submit>Delete</Button>
                      </fetcher.Form>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </BlockStack>
        </Card>

        {/* Add new rule */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Add Pricing Rule</Text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create-rule" />
              <FormLayout>
                <TextField
                  autoComplete="off"
                  label="Rule Name"
                  name="name"
                  value={newRuleName}
                  onChange={setNewRuleName}
                  error={actionErrors?.name?.[0]}
                />
                <Select
                  label="Type"
                  name="type"
                  options={[
                    { label: "Global Discount (all products)", value: "GLOBAL_DISCOUNT" },
                    { label: "Volume Tier (quantity threshold)", value: "VOLUME_TIER" },
                    { label: "Product Override (specific product)", value: "PRODUCT_OVERRIDE" },
                  ]}
                  value={newRuleType}
                  onChange={setNewRuleType}
                />
                <TextField
                  autoComplete="off"
                  label="Discount Percent"
                  name="discountPercent"
                  type="number"
                  suffix="%"
                  helpText={`Must be between 0.1% and 100%. Combined global + volume tier is capped at ${maxDiscountPercent}%.`}
                  value={newRuleDiscount}
                  onChange={setNewRuleDiscount}
                  error={actionErrors?.discountPercent?.[0]}
                />
                <TextField
                  autoComplete="off"
                  label="Minimum Quantity (volume tiers only)"
                  name="minimumQuantity"
                  type="number"
                  helpText="Leave blank for global rules"
                  value={newRuleMinQty}
                  onChange={setNewRuleMinQty}
                  error={actionErrors?.minimumQuantity?.[0]}
                />
                <Button submit>Add Rule</Button>
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>

        {/* Order minimums */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Order Minimums</Text>
            <Text as="p" tone="subdued">
              Wholesale customers must meet these thresholds before checkout is allowed.
            </Text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="update-minimums" />
              <FormLayout>
                <TextField
                  autoComplete="off"
                  label="Minimum Order Value (USD)"
                  name="minimumOrderValue"
                  type="number"
                  prefix="$"
                  value={minOrderValue}
                  onChange={setMinOrderValue}
                  error={actionErrors?.minimumOrderValue?.[0]}
                />
                <TextField
                  autoComplete="off"
                  label="Minimum Order Quantity (optional)"
                  name="minimumOrderQuantity"
                  type="number"
                  helpText="Leave blank to only enforce dollar minimum"
                  value={minOrderQty}
                  onChange={setMinOrderQty}
                  error={actionErrors?.minimumOrderQuantity?.[0]}
                />
                <Button submit>Save Minimums</Button>
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
