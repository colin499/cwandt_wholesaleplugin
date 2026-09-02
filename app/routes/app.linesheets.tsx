/**
 * Order Sheets — customer linesheet drafts and submitted sheets.
 *
 * DRAFT rows are live carts customers are still filling in (autosaved from the
 * storefront linesheet). Submitted sheets are history — a submission that
 * split into a stock + backorder pair shows one row PER DRAFT ORDER, so the
 * in-stock order (packable now) and the backorder are distinct and each has
 * its own pick list.
 */
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
import { parseStoredOrderLines } from "../lib/draft-order-sync.server";

function lineCount(lines: string): number {
  try {
    const parsed = JSON.parse(lines);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const sheets = await db.linesheetDraft.findMany({
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const customers = await db.wholesaleCustomer.findMany({
    where: { shopifyCustomerId: { in: [...new Set(sheets.map((s) => s.shopifyCustomerId))] } },
    select: { shopifyCustomerId: true, email: true, firstName: true, lastName: true, company: true },
  });
  const customerById = new Map(customers.map((c) => [c.shopifyCustomerId, c]));

  const draftOrderIds = sheets.flatMap((s) =>
    [s.shopifyDraftOrderId, s.shopifyBackorderDraftOrderId].filter((id): id is string => !!id)
  );
  const orders = await db.wholesaleOrder.findMany({
    where: { shopifyDraftOrderId: { in: draftOrderIds } },
    select: { shopifyDraftOrderId: true, orderName: true, totalAmount: true, linesJson: true },
  });
  const orderById = new Map(orders.map((o) => [o.shopifyDraftOrderId!, o]));

  return json({
    shop: session.shop,
    drafts: sheets
      .filter((s) => s.status === "DRAFT" && lineCount(s.lines) > 0)
      .map((s) => ({
        id: s.id,
        lineCount: lineCount(s.lines),
        subtotalCents: s.subtotalCents,
        updatedAt: s.updatedAt,
        customer: customerById.get(s.shopifyCustomerId) ?? null,
      })),
    // One row per draft order. The reconciled WholesaleOrder snapshot carries
    // per-order counts/subtotals; legacy sheets without one fall back to the
    // sheet's combined numbers.
    submitted: sheets
      .filter((s) => s.status === "SUBMITTED" && s.shopifyDraftOrderId)
      .flatMap((s) => {
        const customer = customerById.get(s.shopifyCustomerId) ?? null;
        const half = (draftOrderId: string, kind: "stock" | "backorder") => {
          const order = orderById.get(draftOrderId);
          const storedLines = parseStoredOrderLines(order?.linesJson);
          const hasSnapshot = storedLines.length > 0;
          return {
            key: `${s.id}:${draftOrderId}`,
            sheetId: s.id,
            draftOrderId,
            kind,
            orderName:
              order?.orderName ?? (kind === "stock" ? s.orderName : "Backorder"),
            lineCount: hasSnapshot
              ? storedLines.length
              : kind === "stock"
                ? lineCount(s.lines)
                : null,
            subtotalCents: hasSnapshot
              ? Math.round(order!.totalAmount)
              : kind === "stock"
                ? s.subtotalCents
                : null,
            updatedAt: s.updatedAt,
            customer,
          };
        };
        const rows = [half(s.shopifyDraftOrderId!, "stock")];
        if (s.shopifyBackorderDraftOrderId) {
          rows.push(half(s.shopifyBackorderDraftOrderId, "backorder"));
        }
        return rows;
      }),
  });
};

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function customerLabel(c: { email: string; firstName: string | null; lastName: string | null; company: string | null } | null) {
  if (!c) return "Unknown customer";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return c.company || name || c.email;
}

export default function LinesheetsPage() {
  const { drafts, submitted, shop } = useLoaderData<typeof loader>();
  const storeHandle = shop.replace(".myshopify.com", "");

  const customerCell = (c: (typeof drafts)[number]["customer"]) => (
    <IndexTable.Cell>
      <Text as="span" fontWeight="semibold">{customerLabel(c)}</Text>
      {c && <Text as="span" tone="subdued">{" "}{c.email}</Text>}
    </IndexTable.Cell>
  );

  return (
    <Page title="Order Sheets">
      <BlockStack gap="500">
        {drafts.length === 0 && submitted.length === 0 && (
          <Banner title="No order sheets yet" tone="info">
            <Text as="p">
              When wholesale customers enter quantities on the storefront linesheet, their
              in-progress drafts autosave here. Submitted sheets become Shopify draft orders.
            </Text>
          </Banner>
        )}

        {drafts.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">In progress ({drafts.length})</Text>
              <IndexTable
                resourceName={{ singular: "sheet", plural: "sheets" }}
                itemCount={drafts.length}
                selectable={false}
                headings={[
                  { title: "Customer" },
                  { title: "Items" },
                  { title: "Subtotal" },
                  { title: "Updated" },
                ]}
              >
                {drafts.map((s, index) => (
                  <IndexTable.Row id={s.id} key={s.id} position={index}>
                    {customerCell(s.customer)}
                    <IndexTable.Cell>{s.lineCount}</IndexTable.Cell>
                    <IndexTable.Cell>{money(s.subtotalCents)}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(s.updatedAt).toLocaleString()}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        )}

        {submitted.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Submitted ({submitted.length})</Text>
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={submitted.length}
                selectable={false}
                headings={[
                  { title: "Customer" },
                  { title: "Order" },
                  { title: "Type" },
                  { title: "Items" },
                  { title: "Subtotal" },
                  { title: "Updated" },
                  { title: "" },
                ]}
              >
                {submitted.map((row, index) => (
                  <IndexTable.Row id={row.key} key={row.key} position={index}>
                    {customerCell(row.customer)}
                    <IndexTable.Cell>
                      <Link
                        url={`https://admin.shopify.com/store/${storeHandle}/draft_orders/${row.draftOrderId}`}
                        target="_blank"
                      >
                        {row.orderName || "Draft order"}
                      </Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.kind === "backorder" ? (
                        <Badge tone="attention">Backorder</Badge>
                      ) : (
                        <Badge tone="success">In stock</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{row.lineCount ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.subtotalCents != null ? money(row.subtotalCents) : "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{new Date(row.updatedAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Link url={`/app/linesheets/${row.sheetId}?order=${row.draftOrderId}`}>
                        Pick list
                      </Link>
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
