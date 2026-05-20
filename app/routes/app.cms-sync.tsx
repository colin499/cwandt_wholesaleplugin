import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Box,
  IndexTable,
  useIndexResourceState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { syncCmsDataToDb, getCmsSyncState } from "../lib/cms-client.server";
import { db } from "../db.server";

const PAGE_SIZE = 250;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const cmsConfigured = !!(process.env.CMS_BASE_URL && process.env.CMS_API_TOKEN);
  const syncState = await getCmsSyncState();

  const variants = await db.cmsVariantCache.findMany({
    orderBy: { sku: "asc" },
    take: PAGE_SIZE,
  });

  return json({ cmsConfigured, syncState, variants, pageSize: PAGE_SIZE });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const result = await syncCmsDataToDb();
  return json(result);
};

export default function CmsSyncPage() {
  const { cmsConfigured, syncState, variants, pageSize } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSyncing = fetcher.state !== "idle";
  const lastResult = fetcher.data;

  const lastSyncedAt = syncState?.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toLocaleString()
    : "Never";

  const totalCount = syncState?.variantCount ?? 0;
  const showingCount = variants.length;

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(variants.map((v) => ({ id: v.shopifyVariantId })));

  const fmt = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <Page title="CMS Sync" subtitle="Sync wholesale pricing and MOQ data from cms.cwandt.com">
      <BlockStack gap="400">
        {!cmsConfigured && (
          <Banner tone="warning" title="CMS not configured">
            Set <strong>CMS_BASE_URL</strong> and <strong>CMS_API_TOKEN</strong> in
            your environment variables to enable syncing.
          </Banner>
        )}

        {lastResult?.error && (
          <Banner tone="critical" title="Sync failed">
            {lastResult.error}
          </Banner>
        )}

        {lastResult && !lastResult.error && (
          <Banner tone="success" title="Sync complete">
            {lastResult.count} variant{lastResult.count !== 1 ? "s" : ""} synced.
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">Sync Status</Text>
            <InlineStack gap="600" align="start">
              <BlockStack gap="100">
                <Text variant="bodyMd" tone="subdued" as="p">Last synced</Text>
                <Text variant="bodyMd" as="p">{lastSyncedAt}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodyMd" tone="subdued" as="p">Variants cached</Text>
                <Text variant="bodyMd" as="p">{totalCount}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text variant="bodyMd" tone="subdued" as="p">Status</Text>
                {syncState?.lastError ? (
                  <Badge tone="critical">Error</Badge>
                ) : syncState?.lastSyncedAt ? (
                  <Badge tone="success">OK</Badge>
                ) : (
                  <Badge tone="attention">Never synced</Badge>
                )}
              </BlockStack>
            </InlineStack>

            {syncState?.lastError && (
              <Text variant="bodyMd" tone="critical" as="p">
                Last error: {syncState.lastError}
              </Text>
            )}

            <fetcher.Form method="post">
              <Button
                submit
                variant="primary"
                loading={isSyncing}
                disabled={!cmsConfigured || isSyncing}
              >
                {isSyncing ? "Syncing…" : "Sync Now"}
              </Button>
            </fetcher.Form>
          </BlockStack>
        </Card>

        {totalCount > 0 && (
          <Card padding="0">
            <Box paddingInline="400" paddingBlockStart="400" paddingBlockEnd="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Cached Prices</Text>
                <Text variant="bodyMd" tone="subdued" as="p">
                  Showing {showingCount} of {totalCount} variants
                  {totalCount > pageSize ? ` (first ${pageSize} shown)` : ""}
                </Text>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "variant", plural: "variants" }}
              itemCount={showingCount}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "SKU" },
                { title: "Variant ID" },
                { title: "Wholesale Price", alignment: "end" },
                { title: "Distributor Price", alignment: "end" },
                { title: "MOQ", alignment: "end" },
                { title: "CMS Status" },
              ]}
              selectable={false}
            >
              {variants.map((v) => (
                <IndexTable.Row
                  id={v.shopifyVariantId}
                  key={v.shopifyVariantId}
                  position={variants.indexOf(v)}
                  selected={selectedResources.includes(v.shopifyVariantId)}
                >
                  <IndexTable.Cell>
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      {v.sku || "—"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text variant="bodyMd" tone="subdued" as="span">
                      {v.shopifyVariantId}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell flush>
                    <Text variant="bodyMd" as="span" alignment="end">
                      {fmt(v.wholesalePriceCents)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell flush>
                    <Text variant="bodyMd" as="span" alignment="end">
                      {fmt(v.distributorPriceCents)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell flush>
                    <Text variant="bodyMd" as="span" alignment="end">
                      {v.moq}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge>{v.cmsStatus || "—"}</Badge>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}

        {totalCount === 0 && (
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">How it works</Text>
              <Text variant="bodyMd" as="p">
                This page fetches all wholesale variant pricing from the CMS API
                and stores it in the local database. The App Proxy reads from this
                cache on every storefront request — no direct CMS calls at checkout time.
              </Text>
              <Text variant="bodyMd" as="p">
                The cache refreshes automatically in the background every 15 minutes
                when a storefront request is made. Use "Sync Now" to force an immediate
                refresh after updating prices in the CMS.
              </Text>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
