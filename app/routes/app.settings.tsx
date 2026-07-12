import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Banner,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// (Phase A, 2026-07-12: the "Pricing Policy" max-discount setting was removed
// along with the percentage-discount system it capped. Storefront pricing is
// CMS-driven per variant; there is nothing to cap.)

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return json({
    cmsConfigured: !!process.env.CMS_BASE_URL && !!process.env.CMS_API_TOKEN,
    cmsBaseUrl: process.env.CMS_BASE_URL ?? null,
  });
};

export default function SettingsPage() {
  const { cmsConfigured, cmsBaseUrl } = useLoaderData<typeof loader>();

  return (
    <Page title="Settings">
      <BlockStack gap="500">

        {/* CMS Integration */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">CMS Integration</Text>
            <Text as="p" tone="subdued">
              The CMS is the source of truth for wholesale pricing, MOQs, and which
              variants are available for wholesale. Manage the program at{" "}
              {cmsBaseUrl ?? "cms.cwandt.com"} → Wholesale.
            </Text>
            {cmsConfigured ? (
              <Banner title="CMS connected" tone="success">
                <Text as="p">Syncing with {cmsBaseUrl}</Text>
              </Banner>
            ) : (
              <Banner title="CMS not yet configured" tone="warning">
                <Text as="p">
                  To enable pricing sync with the CW&T CMS, set these environment
                  variables on your hosting platform:
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
              Webhooks are declared in shopify.app.toml and registered on deploy.
              The following topics are subscribed:
            </Text>
            <List>
              {[
                "orders/create — record wholesale orders",
                "orders/updated — update WholesaleOrder status",
                "products/create, products/update — log for CMS sync",
                "inventory_levels/update — forward inventory changes to CMS",
                "customers/create, customers/update — reconcile identity + self-heal tags (never enrolls)",
                "app/uninstalled — clean up sessions",
                "customers/data_request, customers/redact, shop/redact — GDPR compliance",
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
              <List.Item>Enable the "Wholesale (site-wide)" app embed</List.Item>
              <List.Item>Add the "Wholesale Price Display" app block to the product template</List.Item>
              <List.Item>Add the "Wholesale Badge" app block to your header section</List.Item>
              <List.Item>Add the "Wholesale Cart Notice" block to the cart template</List.Item>
              <List.Item>Save and publish</List.Item>
            </List>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
