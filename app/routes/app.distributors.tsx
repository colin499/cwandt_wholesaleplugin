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
  InlineStack,
  Button,
  Select,
  TextField,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { enrollCustomer, resolveDiscountPercent } from "../lib/enrollment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const rows = await db.wholesaleCustomer.findMany({
    where: { customerType: "DISTRIBUTOR" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { pricingProfile: true },
  });

  // Resolve the effective rate (override ?? profile) for display.
  const distributors = rows.map((d) => ({ ...d, discountPercent: resolveDiscountPercent(d) }));

  return json({ distributors });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  // ── Create new distributor ────────────────────────────────────────────────
  if (intent === "create") {
    const email = String(formData.get("email") ?? "").trim();
    const company = String(formData.get("company") ?? "").trim();
    const discountPercent = Math.min(
      100,
      Math.max(0, parseFloat(String(formData.get("discountPercent") ?? "50")) || 50)
    );
    const paymentTerms = String(formData.get("paymentTerms") ?? "CREDIT_CARD");
    const rawMin = String(formData.get("minimumOrderValue") ?? "").trim();
    const parsedMin = rawMin === "" ? null : parseFloat(rawMin);
    const minimumOrderValue = parsedMin !== null && !isNaN(parsedMin) && parsedMin >= 0
      ? parsedMin
      : null;

    if (!email || !company) {
      return json({ error: "Email and company are required." }, { status: 400 });
    }

    try {
      // The admin typed an explicit rate, so it's stored as a per-customer
      // override even when it matches the profile default.
      await enrollCustomer(admin, {
        email,
        company,
        customerType: "DISTRIBUTOR",
        discountPercent,
        paymentTerms,
        minimumOrderValue,
      });
    } catch (err) {
      console.error("[distributors] enroll failed:", err);
      return json({ error: "Could not find or create Shopify customer." }, { status: 500 });
    }

    return json({ ok: true });
  }

  const customerId = String(formData.get("customerId"));
  const customer = await db.wholesaleCustomer.findUnique({ where: { id: customerId } });
  if (!customer) return json({ error: "Customer not found" }, { status: 404 });
  const shopifyGid = `gid://shopify/Customer/${customer.shopifyCustomerId}`;

  // ── Update status ─────────────────────────────────────────────────────────
  if (intent === "update_status") {
    const newStatus = String(formData.get("status"));

    if (newStatus === "APPROVED") {
      const existingRes = await admin.graphql(`
        query getCustomerTags($id: ID!) { customer(id: $id) { tags } }
      `, { variables: { id: shopifyGid } });
      const existingData = await existingRes.json();
      const existingTags: string[] = existingData.data?.customer?.tags ?? [];
      const newTags = [...existingTags];
      if (!newTags.includes("wholesale")) newTags.push("wholesale");
      if (!newTags.includes("distributor")) newTags.push("distributor");

      await admin.graphql(`
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
            tags: newTags,
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
        `, { variables: { id: shopifyGid, tags: ["wholesale", "distributor"] } }),

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

  // ── Update per-distributor minimum order value ────────────────────────────
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

function DistributorRow({
  distributor,
  index,
}: {
  distributor: {
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
  const [selectedStatus, setSelectedStatus] = useState(distributor.status);
  const [minValue, setMinValue] = useState(
    distributor.minimumOrderValue != null ? String(distributor.minimumOrderValue) : ""
  );

  const displayName =
    distributor.company ||
    `${distributor.firstName ?? ""} ${distributor.lastName ?? ""}`.trim() ||
    distributor.email;

  return (
    <IndexTable.Row id={distributor.id} key={distributor.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" fontWeight="semibold">{displayName}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{distributor.email}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusTone[distributor.status] ?? "info"}>{distributor.status}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{distributor.discountPercent}%</IndexTable.Cell>
      <IndexTable.Cell>{distributor.paymentTerms.replace("_", " ")}</IndexTable.Cell>
      <IndexTable.Cell>
        <minFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_minimum" />
          <input type="hidden" name="customerId" value={distributor.id} />
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
          <input type="hidden" name="customerId" value={distributor.id} />
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

function CreateDistributorForm() {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [email, setEmail]       = useState("");
  const [company, setCompany]   = useState("");
  const [discount, setDiscount] = useState("50");
  const [terms, setTerms]       = useState("CREDIT_CARD");
  const [minVal, setMinVal]     = useState("");

  const submitted = fetcher.state === "idle" && fetcher.data?.ok;

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Add Distributor Account</Text>
        {submitted && (
          <Banner tone="success">Distributor account created and approved.</Banner>
        )}
        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <BlockStack gap="300">
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Email"
                  autoComplete="off"
                  name="email"
                  value={email}
                  onChange={setEmail}
                  requiredIndicator
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Company"
                  autoComplete="off"
                  name="company"
                  value={company}
                  onChange={setCompany}
                  requiredIndicator
                />
              </div>
            </InlineStack>
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Discount %"
                  autoComplete="off"
                  name="discountPercent"
                  value={discount}
                  onChange={setDiscount}
                  suffix="%"
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Payment Terms"
                  name="paymentTerms"
                  options={[
                    { label: "Credit Card", value: "CREDIT_CARD" },
                    { label: "Net 30", value: "NET_30" },
                    { label: "Net 60", value: "NET_60" },
                  ]}
                  value={terms}
                  onChange={setTerms}
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Min. Order Value"
                  autoComplete="off"
                  name="minimumOrderValue"
                  value={minVal}
                  onChange={setMinVal}
                  prefix="$"
                  placeholder="Global default"
                />
              </div>
            </InlineStack>
            <InlineStack>
              <Button submit loading={fetcher.state !== "idle"}>Create Distributor</Button>
            </InlineStack>
          </BlockStack>
        </fetcher.Form>
      </BlockStack>
    </Card>
  );
}

export default function DistributorsPage() {
  const { distributors } = useLoaderData<typeof loader>();

  return (
    <Page title="Distributors">
      <BlockStack gap="500">
        <CreateDistributorForm />

        <Card>
          <IndexTable
            resourceName={{ singular: "distributor", plural: "distributors" }}
            itemCount={distributors.length}
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
            {distributors.map((d, idx) => (
              <DistributorRow key={d.id} distributor={d} index={idx} />
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}
