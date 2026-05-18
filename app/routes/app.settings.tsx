import { z } from "zod";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
  List,
  FormLayout,
  TextField,
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

const MaxDiscountSchema = z.object({
  maxDiscountPercent: z.coerce
    .number()
    .gt(0, "Must be greater than 0")
    .max(100, "Cannot exceed 100%"),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [settings] = await Promise.all([
    db.wholesaleSettings.findFirst(),
  ]);

  return json({
    cmsConfigured: !!process.env.CMS_BASE_URL && !!process.env.CMS_API_TOKEN,
    cmsBaseUrl: process.env.CMS_BASE_URL ?? null,
    maxDiscountPercent: settings?.maxDiscountPercent ?? 70,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();

  const raw = { maxDiscountPercent: formData.get("maxDiscountPercent") };
  const result = MaxDiscountSchema.safeParse(raw);

  if (!result.success) {
    return json(
      { errors: result.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const existing = await db.wholesaleSettings.findFirst();
  if (existing) {
    await db.wholesaleSettings.update({
      where: { id: existing.id },
      data: { maxDiscountPercent: result.data.maxDiscountPercent },
    });
  } else {
    await db.wholesaleSettings.create({
      data: { maxDiscountPercent: result.data.maxDiscountPercent },
    });
  }

  return json({ ok: true });
};

export default function SettingsPage() {
  const { cmsConfigured, cmsBaseUrl, maxDiscountPercent } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [maxDiscount, setMaxDiscount] = useState(String(maxDiscountPercent));

  const fieldErrors =
    fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;
  const saved = fetcher.data && "ok" in fetcher.data && fetcher.data.ok;

  return (
    <Page title="Settings">
      <BlockStack gap="500">

        {/* Pricing Policy */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Pricing Policy</Text>
            <Text as="p" tone="subdued">
              The maximum combined discount is the hard ceiling that prevents a misconfigured
              global discount + volume tier from producing a zero or negative price.
              The default is 70%. Adjust only if you intentionally offer deeper discounts.
            </Text>
            <fetcher.Form method="post">
              <FormLayout>
                <TextField
                  autoComplete="off"
                  label="Maximum Combined Discount"
                  name="maxDiscountPercent"
                  type="number"
                  suffix="%"
                  helpText="Global discount + volume tier stacking will never exceed this value."
                  value={maxDiscount}
                  onChange={setMaxDiscount}
                  error={fieldErrors?.maxDiscountPercent?.[0]}
                />
                <Button submit>Save</Button>
                {saved && fetcher.state === "idle" && (
                  <Text as="p" tone="success">Saved.</Text>
                )}
              </FormLayout>
            </fetcher.Form>
          </BlockStack>
        </Card>

        {/* CMS Integration */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">CMS Integration</Text>
            {cmsConfigured ? (
              <Banner title="CMS connected" tone="success">
                <Text as="p">Syncing with {cmsBaseUrl}</Text>
              </Banner>
            ) : (
              <Banner title="CMS not yet configured" tone="warning">
                <Text as="p">
                  To enable two-way inventory and pricing sync with the CW&T CMS, set
                  these environment variables on your hosting platform:
                </Text>
                <List>
                  <List.Item>
                    <Text as="span" fontWeight="semibold">CMS_BASE_URL</Text> — base URL of the CMS, e.g. https://cms.cwandt.com
                  </List.Item>
                  <List.Item>
                    <Text as="span" fontWeight="semibold">CMS_API_TOKEN</Text> — bearer token for the CMS wholesale API endpoint
                  </List.Item>
                </List>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {/* Webhook Status */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Webhook Status</Text>
            <Text as="p" tone="subdued">
              Webhooks are registered automatically when the app is installed.
              The following topics are subscribed:
            </Text>
            <List>
              {[
                "orders/create — tag wholesale orders, trigger CMS sync",
                "orders/updated — update WholesaleOrder status",
                "products/update — sync pricing changes from Shopify to app",
                "inventory_levels/update — forward inventory changes to CMS",
                "customers/create — detect new wholesale applicants",
                "customers/update — detect tag changes",
                "app/uninstalled — clean up sessions",
              ].map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
          </BlockStack>
        </Card>

        {/* Theme App Extension */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Theme App Extension</Text>
            <Text as="p" tone="subdued">
              The wholesale storefront UI is injected via a Theme App Extension.
              To activate it on your store:
            </Text>
            <List type="number">
              <List.Item>Go to your Shopify admin → Online Store → Themes</List.Item>
              <List.Item>Click Customize on your active theme</List.Item>
              <List.Item>Navigate to the page using template page.wholesale</List.Item>
              <List.Item>Add the "Wholesale Price Display" app block</List.Item>
              <List.Item>Add the "Wholesale Badge" app block to your header section</List.Item>
              <List.Item>Save and publish</List.Item>
            </List>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
