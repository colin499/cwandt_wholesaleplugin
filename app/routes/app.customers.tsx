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
  BlockStack,
  Button,
  Select,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const customers = await db.wholesaleCustomer.findMany({
    where: { customerType: "WHOLESALE" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return json({ customers });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const customerId = String(formData.get("customerId"));
  const intent = String(formData.get("intent") ?? "update_status");

  const customer = await db.wholesaleCustomer.findUnique({
    where: { id: customerId },
  });
  if (!customer) return json({ error: "Customer not found" }, { status: 404 });

  const shopifyGid = `gid://shopify/Customer/${customer.shopifyCustomerId}`;

  // ── Update status ─────────────────────────────────────────────────────────
  if (intent === "update_status") {
    const newStatus = String(formData.get("status"));

    if (newStatus === "APPROVED") {
      const existingRes = await admin.graphql(`
        query getCustomerTags($id: ID!) {
          customer(id: $id) { tags }
        }
      `, { variables: { id: shopifyGid } });
      const existingData = await existingRes.json();
      const existingTags: string[] = existingData.data?.customer?.tags ?? [];

      await admin.graphql(`
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id tags }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: {
            id: shopifyGid,
            tags: existingTags.includes("wholesale") ? existingTags : [...existingTags, "wholesale"],
            metafields: [{ namespace: "wholesale", key: "status", value: "approved", type: "single_line_text_field" }],
          },
        },
      });
    } else if (newStatus === "SUSPENDED" || newStatus === "REJECTED") {
      await Promise.all([
        admin.graphql(`
          mutation customerRemoveTags($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) {
              node { id }
              userErrors { field message }
            }
          }
        `, { variables: { id: shopifyGid, tags: ["wholesale"] } }),

        admin.graphql(`
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id }
              userErrors { field message }
            }
          }
        `, {
          variables: {
            input: {
              id: shopifyGid,
              metafields: [{ namespace: "wholesale", key: "status", value: "inactive", type: "single_line_text_field" }],
            },
          },
        }),
      ]);
    }

    await db.wholesaleCustomer.update({
      where: { id: customerId },
      data: {
        status: newStatus as any,
        approvedAt: newStatus === "APPROVED" ? new Date() : undefined,
      },
    });
  }

  // ── Update per-customer minimum order value ───────────────────────────────
  if (intent === "update_minimum") {
    const raw = String(formData.get("minimumOrderValue") ?? "").trim();
    const parsed = raw === "" ? null : parseFloat(raw);
    const minimumOrderValue = parsed === null || isNaN(parsed) || parsed < 0 ? null : parsed;

    await db.wholesaleCustomer.update({
      where: { id: customerId },
      data: { minimumOrderValue },
    });

    if (minimumOrderValue !== null) {
      await admin.graphql(`
        mutation SetMinimumMetafield($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: {
            id: shopifyGid,
            metafields: [{
              namespace: "wholesale",
              key: "minimum_order_value",
              value: String(minimumOrderValue),
              type: "single_line_text_field",
            }],
          },
        },
      });
    } else {
      // Clear the per-customer override — delete the metafield if it exists
      const mfRes = await admin.graphql(`
        query GetMinimumMetafield($id: ID!) {
          customer(id: $id) {
            metafield(namespace: "wholesale", key: "minimum_order_value") { id }
          }
        }
      `, { variables: { id: shopifyGid } });
      const mfData = await mfRes.json();
      const metafieldId = mfData.data?.customer?.metafield?.id;
      if (metafieldId) {
        await admin.graphql(`
          mutation DeleteMinimumMetafield($input: [ID!]!) {
            metafieldsDelete(metafields: $input) {
              userErrors { field message }
            }
          }
        `, { variables: { input: [metafieldId] } });
      }
    }
  }

  return json({ ok: true });
};

const statusTone: Record<string, "success" | "attention" | "critical" | "info"> = {
  APPROVED: "success",
  PENDING: "attention",
  REJECTED: "critical",
  SUSPENDED: "info",
};

function CustomerRow({
  customer,
  index,
}: {
  customer: {
    id: string;
    company: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    status: string;
    discountPercent: number;
    paymentTerms: string;
    minimumOrderValue: number | null;
  };
  index: number;
}) {
  const statusFetcher = useFetcher();
  const minFetcher = useFetcher();
  const [selectedStatus, setSelectedStatus] = useState(customer.status);
  const [minValue, setMinValue] = useState(
    customer.minimumOrderValue != null ? String(customer.minimumOrderValue) : ""
  );

  const displayName =
    customer.company ||
    `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() ||
    customer.email;

  return (
    <IndexTable.Row id={customer.id} key={customer.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" fontWeight="semibold">{displayName}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{customer.email}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusTone[customer.status] ?? "info"}>{customer.status}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{customer.discountPercent}%</IndexTable.Cell>
      <IndexTable.Cell>{customer.paymentTerms.replace("_", " ")}</IndexTable.Cell>
      <IndexTable.Cell>
        <minFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_minimum" />
          <input type="hidden" name="customerId" value={customer.id} />
          <BlockStack gap="200" inlineAlign="start">
            <TextField
              label=""
              labelHidden
              autoComplete="off"
              prefix="$"
              placeholder="Global default"
              value={minValue}
              onChange={setMinValue}
              name="minimumOrderValue"
            />
            <Button submit size="slim" loading={minFetcher.state !== "idle"}>Save</Button>
          </BlockStack>
        </minFetcher.Form>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <statusFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_status" />
          <input type="hidden" name="customerId" value={customer.id} />
          <BlockStack gap="200" inlineAlign="start">
            <Select
              label=""
              labelHidden
              name="status"
              options={[
                { label: "Approved", value: "APPROVED" },
                { label: "Pending", value: "PENDING" },
                { label: "Suspended", value: "SUSPENDED" },
                { label: "Rejected", value: "REJECTED" },
              ]}
              value={selectedStatus}
              onChange={setSelectedStatus}
            />
            <Button submit size="slim" loading={statusFetcher.state !== "idle"}>Save</Button>
          </BlockStack>
        </statusFetcher.Form>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function CustomersPage() {
  const { customers } = useLoaderData<typeof loader>();

  return (
    <Page title="Wholesale Customers">
      <Card>
        <IndexTable
          resourceName={{ singular: "customer", plural: "customers" }}
          itemCount={customers.length}
          headings={[
            { title: "Company" },
            { title: "Email" },
            { title: "Status" },
            { title: "Discount" },
            { title: "Payment Terms" },
            { title: "Min. Order" },
            { title: "Actions" },
          ]}
          selectable={false}
        >
          {customers.map((c, idx) => (
            <CustomerRow key={c.id} customer={c} index={idx} />
          ))}
        </IndexTable>
      </Card>
    </Page>
  );
}
