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
// (Phase A, 2026-07-12: the PricingRule system — global discount, volume
// tiers, product overrides — was retired. Storefront pricing is CMS-driven
// per variant; profiles below carry per-segment terms and metadata.)

const UpdateProfileSchema = z.object({
  discountPercent: z.coerce
    .number()
    .gt(0, "Discount must be greater than 0")
    .max(100, "Discount cannot exceed 100%"),
  paymentTerms: z.enum(["CREDIT_CARD", "NET_30", "NET_60"]),
  minimumOrderValue: z.coerce
    .number()
    .min(0, "Minimum order value cannot be negative")
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

  const [minimumConfig, profiles] = await Promise.all([
    db.orderMinimumConfig.findFirst({ where: { active: true } }),
    db.pricingProfile.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { customers: true } } },
    }),
  ]);

  return json({ minimumConfig, profiles });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "update-profile") {
    const profileId = String(formData.get("profileId"));
    const raw = {
      discountPercent: formData.get("discountPercent"),
      paymentTerms: String(formData.get("paymentTerms") ?? ""),
      minimumOrderValue: formData.get("minimumOrderValue") || null,
    };

    const result = UpdateProfileSchema.safeParse(raw);
    if (!result.success) {
      return json({ errors: result.error.flatten().fieldErrors }, { status: 422 });
    }

    await db.pricingProfile.update({ where: { id: profileId }, data: result.data });
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

function ProfileRow({
  profile,
}: {
  profile: {
    id: string;
    name: string;
    discountPercent: number;
    paymentTerms: string;
    minimumOrderValue: number | null;
    _count: { customers: number };
  };
}) {
  const fetcher = useFetcher();
  const [discount, setDiscount] = useState(String(profile.discountPercent));
  const [terms, setTerms] = useState(profile.paymentTerms);
  const [minVal, setMinVal] = useState(
    profile.minimumOrderValue != null ? String(profile.minimumOrderValue) : ""
  );

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="update-profile" />
      <input type="hidden" name="profileId" value={profile.id} />
      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ minWidth: 140 }}>
          <BlockStack gap="100">
            <Text as="span" fontWeight="semibold">{profile.name}</Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {profile._count.customers} customer{profile._count.customers === 1 ? "" : "s"}
            </Text>
          </BlockStack>
        </div>
        <div style={{ width: 120 }}>
          <TextField
            label="Discount"
            autoComplete="off"
            name="discountPercent"
            suffix="%"
            value={discount}
            onChange={setDiscount}
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            label="Default terms"
            name="paymentTerms"
            options={[
              { label: "Credit Card", value: "CREDIT_CARD" },
              { label: "Net 30", value: "NET_30" },
              { label: "Net 60", value: "NET_60" },
            ]}
            value={terms}
            onChange={setTerms}
          />
        </div>
        <div style={{ width: 140 }}>
          <TextField
            label="Min. order"
            autoComplete="off"
            name="minimumOrderValue"
            prefix="$"
            placeholder="Global default"
            value={minVal}
            onChange={setMinVal}
          />
        </div>
        <Button submit loading={fetcher.state !== "idle"}>Save</Button>
      </InlineStack>
    </fetcher.Form>
  );
}

export default function PricingPage() {
  const { minimumConfig, profiles } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [minOrderValue, setMinOrderValue] = useState(
    String(minimumConfig?.minimumOrderValue ?? 500)
  );
  const [minOrderQty, setMinOrderQty] = useState(
    minimumConfig?.minimumOrderQuantity ? String(minimumConfig.minimumOrderQuantity) : ""
  );

  // Field-level errors returned from the action
  const actionErrors =
    fetcher.data && "errors" in fetcher.data
      ? (fetcher.data.errors as Record<string, string[] | undefined>)
      : null;

  return (
    <Page title="Pricing">
      <BlockStack gap="500">
        {/* Pricing profiles — per-segment terms; per-variant prices live in the CMS */}
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Pricing Profiles</Text>
              <Text as="p" tone="subdued">
                Per-segment payment terms and minimums. Product prices come from the
                CMS per variant (cms.cwandt.com → Wholesale) — a variant not entered
                there is not available for wholesale at all.
              </Text>
            </BlockStack>
            {profiles.map((p) => (
              <ProfileRow key={p.id} profile={p} />
            ))}
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
