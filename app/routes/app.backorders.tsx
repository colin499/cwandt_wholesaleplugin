import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Link,
  BlockStack,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const backorders = await db.wholesaleOrder.findMany({
    where: { isBackorder: true },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { customer: { select: { company: true, email: true, firstName: true, lastName: true } } },
  });

  return json({ backorders, shop: session.shop });
};

const statusTone: Record<string, "attention" | "success" | "critical" | "info"> = {
  PENDING: "attention",
  CONFIRMED: "info",
  FULFILLED: "success",
  CANCELLED: "critical",
};

export default function BackordersPage() {
  const { backorders, shop } = useLoaderData<typeof loader>();

  const pending = backorders.filter((b) => b.status === "PENDING" || b.status === "CONFIRMED");
  const completed = backorders.filter((b) => b.status === "FULFILLED" || b.status === "CANCELLED");

  return (
    <Page title="Wholesale Backorders">
      <BlockStack gap="500">
        {pending.length === 0 && (
          <Banner title="No open backorders" tone="info">
            <Text as="p">
              When wholesale customers request backorders for out-of-stock items, they appear here.
              Each backorder creates a Shopify Draft Order — fulfill it from the Shopify Admin when
              stock arrives.
            </Text>
          </Banner>
        )}

        {pending.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Open ({pending.length})</Text>
              <IndexTable
                resourceName={{ singular: "backorder", plural: "backorders" }}
                itemCount={pending.length}
                headings={[
                  { title: "Order" },
                  { title: "Customer" },
                  { title: "Discount" },
                  { title: "Status" },
                  { title: "Placed" },
                  { title: "Shopify Draft" },
                ]}
                selectable={false}
              >
                {pending.map((order, idx) => (
                  <IndexTable.Row id={order.id} key={order.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">{order.orderName || "—"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.customer.company ||
                        `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim() ||
                        order.customer.email}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{order.discountPercent}%</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={statusTone[order.status] ?? "info"}>{order.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(order.createdAt).toLocaleDateString()}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.shopifyDraftOrderId ? (
                        <Link
                          url={`https://${shop}/admin/draft_orders/${order.shopifyDraftOrderId}`}
                          target="_blank"
                        >
                          View in Shopify →
                        </Link>
                      ) : (
                        "—"
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}

        {completed.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Completed / Cancelled ({completed.length})</Text>
              <IndexTable
                resourceName={{ singular: "backorder", plural: "backorders" }}
                itemCount={completed.length}
                headings={[
                  { title: "Order" },
                  { title: "Customer" },
                  { title: "Status" },
                  { title: "Total" },
                  { title: "Placed" },
                ]}
                selectable={false}
              >
                {completed.map((order, idx) => (
                  <IndexTable.Row id={order.id} key={order.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">{order.orderName || "—"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.customer.company ||
                        `${order.customer.firstName ?? ""} ${order.customer.lastName ?? ""}`.trim() ||
                        order.customer.email}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={statusTone[order.status] ?? "info"}>{order.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.totalAmount > 0
                        ? (order.totalAmount / 100).toLocaleString("en-US", {
                            style: "currency",
                            currency: "USD",
                          })
                        : "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(order.createdAt).toLocaleDateString()}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
