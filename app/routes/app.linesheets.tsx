/**
 * Order Sheets — customer linesheet drafts and submitted sheets.
 *
 * DRAFT rows are live carts customers are still filling in (autosaved from the
 * storefront linesheet). SUBMITTED rows are history — each one maps to a
 * Shopify draft order and can be duplicated by the customer as a new draft.
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

  return json({
    shop: session.shop,
    sheets: sheets.map((s) => ({
      id: s.id,
      status: s.status,
      lineCount: lineCount(s.lines),
      subtotalCents: s.subtotalCents,
      orderName: s.orderName,
      shopifyDraftOrderId: s.shopifyDraftOrderId,
      updatedAt: s.updatedAt,
      customer: customerById.get(s.shopifyCustomerId) ?? null,
    })),
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
  const { sheets, shop } = useLoaderData<typeof loader>();
  const storeHandle = shop.replace(".myshopify.com", "");

  const drafts = sheets.filter((s) => s.status === "DRAFT" && s.lineCount > 0);
  const submitted = sheets.filter((s) => s.status === "SUBMITTED");

  const table = (rows: typeof sheets) => (
    <IndexTable
      resourceName={{ singular: "sheet", plural: "sheets" }}
      itemCount={rows.length}
      selectable={false}
      headings={[
        { title: "Customer" },
        { title: "Items" },
        { title: "Subtotal" },
        { title: "Updated" },
        { title: "Order" },
      ]}
    >
      {rows.map((s, index) => (
        <IndexTable.Row id={s.id} key={s.id} position={index}>
          <IndexTable.Cell>
            <Text as="span" fontWeight="semibold">{customerLabel(s.customer)}</Text>
            {s.customer && (
              <Text as="span" tone="subdued">{" "}{s.customer.email}</Text>
            )}
          </IndexTable.Cell>
          <IndexTable.Cell>{s.lineCount}</IndexTable.Cell>
          <IndexTable.Cell>{money(s.subtotalCents)}</IndexTable.Cell>
          <IndexTable.Cell>{new Date(s.updatedAt).toLocaleString()}</IndexTable.Cell>
          <IndexTable.Cell>
            {s.status === "SUBMITTED" && s.shopifyDraftOrderId ? (
              <Link
                url={`https://admin.shopify.com/store/${storeHandle}/draft_orders/${s.shopifyDraftOrderId}`}
                target="_blank"
              >
                {s.orderName || "Draft order"}
              </Link>
            ) : (
              <Badge tone="attention">Draft</Badge>
            )}
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
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
              {table(drafts)}
            </BlockStack>
          </Card>
        )}

        {submitted.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Submitted ({submitted.length})</Text>
              {table(submitted)}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
