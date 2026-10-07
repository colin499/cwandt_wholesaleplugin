/**
 * UPS Shipping — orders waiting to ship for customers who are billed on
 * their own UPS account, plus a lookup by order number.
 *
 * Lists straight from Shopify (open draft orders + unfulfilled orders), so
 * orders staff create by hand in Shopify Admin show up here too — not just
 * ones submitted through the order sheet. Each row opens the Ship page.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Banner,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Badge,
  Link,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getUpsConfig } from "../lib/ups.server";
import { listShippableOrders } from "../lib/ups-ship.server";
import { formatCharge } from "../lib/ups-services";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const search = new URL(request.url).searchParams.get("q") ?? "";
  const config = getUpsConfig();
  return json({
    search,
    upsEnabled: config !== null,
    environment: config?.environment ?? null,
    ...(await listShippableOrders(admin, search)),
  });
};

export default function ShippingPage() {
  const { search, upsEnabled, environment, rows, billableCount, error } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const [query, setQuery] = useState(search);

  const loading = navigation.state !== "idle";
  const runSearch = (q: string) => setSearchParams(q.trim() ? { q: q.trim() } : {});

  return (
    <Page
      title="UPS Shipping"
      subtitle="Buy UPS labels billed to the customer's own UPS account"
    >
      <BlockStack gap="400">
        {!upsEnabled && (
          <Banner tone="warning" title="UPS isn't connected yet">
            <Text as="p">Labels can be bought once the app's UPS credentials are set.</Text>
          </Banner>
        )}
        {upsEnabled && environment === "TEST" && (
          <Banner tone="warning" title="Test mode">
            <Text as="p">
              Labels are samples from UPS's test environment — not valid for shipping, and
              nobody is charged.
            </Text>
          </Banner>
        )}
        {error === "ACCESS" && (
          <Banner tone="critical" title="Shopify blocked the order list">
            <Text as="p">
              The app isn't allowed to read some customer fields. Check Protected customer data
              access in the app's API access settings.
            </Text>
          </Banner>
        )}
        {error === "OTHER" && (
          <Banner tone="critical">
            <Text as="p">Couldn't load orders from Shopify. Reload to try again.</Text>
          </Banner>
        )}
        {!search && billableCount === 0 && (
          <Banner tone="info" title="No customers are billed on their UPS account yet">
            <Text as="p">
              Under Customers, open a customer's UPS button, enter their account number and
              billing ZIP, and tick "Bill this account for shipping". Their open orders then
              appear here.
            </Text>
          </Banner>
        )}

        <Card>
          <div
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(query);
            }}
          >
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Find an order by number"
                  autoComplete="off"
                  placeholder="e.g. 1234 or D56"
                  value={query}
                  onChange={setQuery}
                  clearButton
                  onClearButtonClick={() => {
                    setQuery("");
                    runSearch("");
                  }}
                />
              </div>
              <Button loading={loading} onClick={() => runSearch(query)}>
                Search
              </Button>
            </InlineStack>
          </div>
        </Card>

        <Card padding="0">
          <div style={{ padding: "16px 16px 8px" }}>
            <Text as="h2" variant="headingMd">
              {search
                ? `Orders matching "${search}"`
                : "Waiting to ship — customers billed on their UPS account"}
            </Text>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: "8px 16px 16px" }}>
              <Text as="p" tone="subdued">
                {search
                  ? "No open order or draft order matches that number."
                  : "Nothing waiting. Orders and draft orders you create in Shopify for those customers appear here until they are fulfilled."}
              </Text>
            </div>
          ) : (
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={rows.length}
              headings={[
                { title: "Order" },
                { title: "Customer" },
                { title: "Created" },
                { title: "Status" },
                { title: "UPS label" },
                { title: "" },
              ]}
              selectable={false}
            >
              {rows.map((r, idx) => {
                const url = `/app/shipping/${r.kind === "ORDER" ? "order" : "draft"}/${r.id}`;
                return (
                  <IndexTable.Row id={`${r.kind}:${r.id}`} key={`${r.kind}:${r.id}`} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">{r.name}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{r.customerName}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {r.status}
                      {!r.hasAddress && (
                        <Text as="span" tone="critical" variant="bodySm">
                          {" "}· no shipping address
                        </Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {r.labels > 0 ? (
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone="success">
                            {`${r.labels} label${r.labels === 1 ? "" : "s"}`}
                          </Badge>
                          {r.estimatedTotal && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              est. {formatCharge(r.estimatedTotal)}
                            </Text>
                          )}
                        </InlineStack>
                      ) : (
                        <Text as="span" tone="subdued">—</Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Link url={url}>{r.labels > 0 ? "View" : "Ship with UPS"}</Link>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
