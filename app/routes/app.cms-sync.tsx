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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { syncCmsDataToDb, getCmsSyncState } from "../lib/cms-client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const cmsConfigured = !!(process.env.CMS_BASE_URL && process.env.CMS_API_TOKEN);
  const syncState = await getCmsSyncState();

  return json({ cmsConfigured, syncState });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const result = await syncCmsDataToDb();
  return json(result);
};

export default function CmsSyncPage() {
  const { cmsConfigured, syncState } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSyncing = fetcher.state !== "idle";
  const lastResult = fetcher.data;

  const lastSyncedAt = syncState?.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toLocaleString()
    : "Never";

  return (
    <Page title="CMS Sync" subtitle="Sync wholesale pricing and MOQ data from cms.cwandt.com">
      <BlockStack gap="400">
        {!cmsConfigured && (
          <Banner tone="warning" title="CMS not configured">
            Set <strong>CMS_BASE_URL</strong> and <strong>CMS_API_TOKEN</strong> environment
            variables to enable syncing.
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
                <Text variant="bodyMd" as="p">{syncState?.variantCount ?? 0}</Text>
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
      </BlockStack>
    </Page>
  );
}
