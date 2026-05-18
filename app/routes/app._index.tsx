import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
  InlineStack,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [
    wholesaleCount,
    distributorCount,
    pendingApplications,
    openBackorders,
    syncState,
  ] = await Promise.all([
    db.wholesaleCustomer.count({ where: { status: "APPROVED", customerType: "WHOLESALE" } }),
    db.wholesaleCustomer.count({ where: { status: "APPROVED", customerType: "DISTRIBUTOR" } }),
    db.wholesaleApplication.count({ where: { status: "PENDING" } }),
    db.wholesaleOrder.count({ where: { isBackorder: true, status: { in: ["PENDING", "CONFIRMED"] } } }),
    db.cmsSyncState.findUnique({ where: { id: "singleton" } }),
  ]);

  return json({
    stats: { wholesaleCount, distributorCount, pendingApplications, openBackorders },
    syncState,
    cmsConfigured: !!(process.env.CMS_BASE_URL && process.env.CMS_API_TOKEN),
  });
};

export default function Index() {
  const { stats, syncState, cmsConfigured } = useLoaderData<typeof loader>();

  const lastSynced = syncState?.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toLocaleString()
    : null;

  const syncAgeMs = syncState?.lastSyncedAt
    ? Date.now() - new Date(syncState.lastSyncedAt).getTime()
    : null;

  const syncIsStale = syncAgeMs !== null && syncAgeMs > 15 * 60 * 1000;

  return (
    <Page title="CW&T Wholesale">
      <BlockStack gap="500">
        <InlineGrid columns={4} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Wholesale Accounts</Text>
              <Text as="p" variant="heading2xl">{stats.wholesaleCount}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Distributors</Text>
              <Text as="p" variant="heading2xl">{stats.distributorCount}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Pending Applications</Text>
              <Text as="p" variant="heading2xl">
                {stats.pendingApplications > 0 ? (
                  <Badge tone="attention">{String(stats.pendingApplications)}</Badge>
                ) : (
                  "0"
                )}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="subdued">Open Backorders</Text>
              <Text as="p" variant="heading2xl">
                {stats.openBackorders > 0 ? (
                  <Badge tone="attention">{String(stats.openBackorders)}</Badge>
                ) : (
                  "0"
                )}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">CMS Sync</Text>
                {!cmsConfigured ? (
                  <Text as="p" tone="subdued">
                    CMS not configured. Set <strong>CMS_BASE_URL</strong> and{" "}
                    <strong>CMS_API_TOKEN</strong> to enable pricing sync.
                  </Text>
                ) : !lastSynced ? (
                  <Text as="p" tone="subdued">
                    CMS is configured but has never been synced.{" "}
                    <Link url="/app/cms-sync">Run first sync →</Link>
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    <InlineStack gap="300" align="start" blockAlign="center">
                      <Text as="p">
                        Last sync: <strong>{lastSynced}</strong>
                      </Text>
                      <Badge tone={syncState?.lastError ? "critical" : syncIsStale ? "attention" : "success"}>
                        {syncState?.lastError ? "Error" : syncIsStale ? "Stale" : "Current"}
                      </Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      {syncState?.variantCount ?? 0} variants cached.{" "}
                      <Link url="/app/cms-sync">Manage sync →</Link>
                    </Text>
                    {syncState?.lastError && (
                      <Text as="p" tone="critical">Error: {syncState.lastError}</Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Quick Links</Text>
                <Text as="p">
                  <Link url="/app/applications">Review pending applications →</Link>
                </Text>
                <Text as="p">
                  <Link url="/app/backorders">View open backorders →</Link>
                </Text>
                <Text as="p">
                  <Link url="/app/pricing">Configure pricing rules →</Link>
                </Text>
                <Text as="p">
                  <Link url="/app/cms-sync">CMS sync →</Link>
                </Text>
                <Text as="p">
                  <Link url="/app/settings">Settings →</Link>
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
