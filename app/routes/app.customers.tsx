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
  Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  enrollCustomer,
  resolveDiscountPercent,
  syncCustomerToShopify,
  defaultProfileIdForType,
  backfillFromShopify,
  type BackfillResult,
} from "../lib/enrollment.server";

const CUSTOMER_TYPES = [
  { label: "Wholesale", value: "WHOLESALE" },
  { label: "Distributor", value: "DISTRIBUTOR" },
  { label: "B2B", value: "B2B" },
];

const PAYMENT_TERMS = [
  { label: "Credit Card", value: "CREDIT_CARD" },
  { label: "Net 30", value: "NET_30" },
  { label: "Net 60", value: "NET_60" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const rows = await db.wholesaleCustomer.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { pricingProfile: true },
  });

  const customers = rows.map((c) => ({
    id: c.id,
    shopifyCustomerId: c.shopifyCustomerId,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    company: c.company,
    status: c.status,
    customerType: c.customerType,
    paymentTerms: c.paymentTerms,
    minimumOrderValue: c.minimumOrderValue,
    effectiveDiscount: resolveDiscountPercent(c),
    hasDiscountOverride: c.discountPercent !== null,
    profileName: c.pricingProfile?.name ?? null,
  }));

  return json({ customers });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  // ── Search the shop's full customer list ──────────────────────────────────
  if (intent === "search") {
    const q = String(formData.get("q") ?? "").trim();
    if (!q) return json({ results: [] });

    const res = await admin.graphql(
      `query SearchCustomers($query: String!) {
        customers(first: 10, query: $query) {
          edges {
            node { id legacyResourceId email firstName lastName tags }
          }
        }
      }`,
      { variables: { query: q } }
    );
    const data = await res.json();
    const nodes: Array<{
      legacyResourceId: string;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      tags: string[];
    }> = (data.data?.customers?.edges ?? []).map((e: any) => e.node);

    const enrolledRows = await db.wholesaleCustomer.findMany({
      where: { shopifyCustomerId: { in: nodes.map((n) => n.legacyResourceId) } },
      select: { shopifyCustomerId: true, customerType: true, status: true },
    });
    const enrolledById = new Map(enrolledRows.map((r) => [r.shopifyCustomerId, r]));

    return json({
      results: nodes.map((n) => ({
        shopifyCustomerId: n.legacyResourceId,
        email: n.email,
        firstName: n.firstName,
        lastName: n.lastName,
        enrolled: enrolledById.get(n.legacyResourceId) ?? null,
      })),
    });
  }

  // ── Enroll (search result or brand-new email) ─────────────────────────────
  if (intent === "enroll") {
    const email = String(formData.get("email") ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "A valid email is required." }, { status: 400 });
    }
    const customerType = String(formData.get("customerType") ?? "WHOLESALE");
    const rawDiscount = String(formData.get("discountPercent") ?? "").trim();
    const parsedDiscount = rawDiscount === "" ? null : parseFloat(rawDiscount);
    const discountPercent =
      parsedDiscount !== null && !isNaN(parsedDiscount)
        ? Math.min(100, Math.max(0, parsedDiscount))
        : null;
    const rawMin = String(formData.get("minimumOrderValue") ?? "").trim();
    const parsedMin = rawMin === "" ? null : parseFloat(rawMin);
    const minimumOrderValue =
      parsedMin !== null && !isNaN(parsedMin) && parsedMin >= 0 ? parsedMin : null;

    try {
      await enrollCustomer(admin, {
        email,
        firstName: String(formData.get("firstName") ?? "") || undefined,
        lastName: String(formData.get("lastName") ?? "") || undefined,
        company: String(formData.get("company") ?? "") || undefined,
        customerType,
        discountPercent,
        paymentTerms: String(formData.get("paymentTerms") ?? "") || undefined,
        minimumOrderValue,
      });
    } catch (err) {
      console.error("[customers] enroll failed:", err);
      // Surface the underlying GraphQL/user error — "see server log" hides
      // actionable causes like missing scopes or protected customer data.
      const detail =
        err instanceof Error
          ? [err.message, JSON.stringify((err as any).body?.errors ?? "") !== '""' ? JSON.stringify((err as any).body?.errors) : ""]
              .filter(Boolean)
              .join(" — ")
          : String(err);
      return json({ error: `Could not enroll customer: ${detail}` }, { status: 500 });
    }
    return json({ enrolled: true });
  }

  // ── Backfill / reconcile sweep ────────────────────────────────────────────
  if (intent === "backfill") {
    const dryRun = String(formData.get("mode")) !== "apply";
    try {
      const backfill = await backfillFromShopify(admin, { dryRun });
      return json({ backfill });
    } catch (err) {
      console.error("[customers] backfill failed:", err);
      return json({ error: "Backfill failed. See server log." }, { status: 500 });
    }
  }

  // ── Row updates ───────────────────────────────────────────────────────────
  const customerId = String(formData.get("customerId"));
  const customer = await db.wholesaleCustomer.findUnique({ where: { id: customerId } });
  if (!customer) return json({ error: "Customer not found" }, { status: 404 });

  if (intent === "update_status") {
    const newStatus = String(formData.get("status"));
    if (!["APPROVED", "PENDING", "SUSPENDED", "REJECTED"].includes(newStatus)) {
      return json({ error: "Invalid status" }, { status: 400 });
    }
    await db.wholesaleCustomer.update({
      where: { id: customerId },
      data: {
        status: newStatus,
        approvedAt: newStatus === "APPROVED" ? new Date() : undefined,
      },
    });
  }

  if (intent === "update_type") {
    const newType = String(formData.get("customerType"));
    if (!CUSTOMER_TYPES.some((t) => t.value === newType)) {
      return json({ error: "Invalid customer type" }, { status: 400 });
    }
    // A type change re-points the account at that type's default profile.
    // A per-customer discount override, if any, survives the change.
    await db.wholesaleCustomer.update({
      where: { id: customerId },
      data: {
        customerType: newType,
        pricingProfileId: defaultProfileIdForType(newType),
      },
    });
  }

  if (intent === "update_minimum") {
    const raw = String(formData.get("minimumOrderValue") ?? "").trim();
    const parsed = raw === "" ? null : parseFloat(raw);
    const minimumOrderValue = parsed === null || isNaN(parsed) || parsed < 0 ? null : parsed;
    await db.wholesaleCustomer.update({
      where: { id: customerId },
      data: { minimumOrderValue },
    });
  }

  // Every row mutation re-projects tags + metafields from the updated row.
  await syncCustomerToShopify(admin, customer.shopifyCustomerId);

  return json({ ok: true });
};

const statusTone: Record<string, "success" | "attention" | "critical" | "info"> = {
  APPROVED: "success",
  PENDING: "attention",
  REJECTED: "critical",
  SUSPENDED: "info",
};

type CustomerRowData = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  status: string;
  customerType: string;
  paymentTerms: string;
  minimumOrderValue: number | null;
  effectiveDiscount: number;
  hasDiscountOverride: boolean;
  profileName: string | null;
};

function CustomerRow({ customer, index }: { customer: CustomerRowData; index: number }) {
  const statusFetcher = useFetcher();
  const typeFetcher = useFetcher();
  const minFetcher = useFetcher();
  const [selectedStatus, setSelectedStatus] = useState(customer.status);
  const [selectedType, setSelectedType] = useState(customer.customerType);
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
        <typeFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_type" />
          <input type="hidden" name="customerId" value={customer.id} />
          <BlockStack gap="200" inlineAlign="start">
            <Select
              label=""
              labelHidden
              name="customerType"
              options={CUSTOMER_TYPES}
              value={selectedType}
              onChange={setSelectedType}
            />
            {selectedType !== customer.customerType && (
              <Button submit size="slim" loading={typeFetcher.state !== "idle"}>Save</Button>
            )}
          </BlockStack>
        </typeFetcher.Form>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusTone[customer.status] ?? "info"}>{customer.status}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span">
          {customer.effectiveDiscount}%{" "}
          <Text as="span" tone="subdued" variant="bodySm">
            {customer.hasDiscountOverride ? "(override)" : `(${customer.profileName ?? "profile"})`}
          </Text>
        </Text>
      </IndexTable.Cell>
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
              placeholder="Default"
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

type SearchResult = {
  shopifyCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enrolled: { customerType: string; status: string } | null;
};

function AddCustomerCard() {
  const searchFetcher = useFetcher<{ results?: SearchResult[] }>();
  const enrollFetcher = useFetcher<{ enrolled?: boolean; error?: string }>();

  const [query, setQuery] = useState("");
  const [type, setType] = useState("WHOLESALE");
  const [terms, setTerms] = useState("CREDIT_CARD");
  const [company, setCompany] = useState("");
  const [discount, setDiscount] = useState("");
  const [minVal, setMinVal] = useState("");

  const results = searchFetcher.data?.results ?? [];
  const searched = searchFetcher.data !== undefined;
  const queryLooksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query.trim());

  // Shared enrollment settings rendered as hidden inputs in every enroll form.
  const settingsInputs = (
    <>
      <input type="hidden" name="intent" value="enroll" />
      <input type="hidden" name="customerType" value={type} />
      <input type="hidden" name="paymentTerms" value={terms} />
      <input type="hidden" name="company" value={company} />
      <input type="hidden" name="discountPercent" value={discount} />
      <input type="hidden" name="minimumOrderValue" value={minVal} />
    </>
  );

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Add Customer</Text>
        {enrollFetcher.data?.enrolled && (
          <Banner tone="success">Customer enrolled and approved.</Banner>
        )}
        {enrollFetcher.data?.error && (
          <Banner tone="critical">{enrollFetcher.data.error}</Banner>
        )}

        <InlineStack gap="300" wrap>
          <div style={{ minWidth: 140 }}>
            <Select label="Type" options={CUSTOMER_TYPES} value={type} onChange={setType} />
          </div>
          <div style={{ minWidth: 140 }}>
            <Select label="Payment Terms" options={PAYMENT_TERMS} value={terms} onChange={setTerms} />
          </div>
          <div style={{ minWidth: 140 }}>
            <TextField
              label="Company"
              autoComplete="off"
              value={company}
              onChange={setCompany}
              placeholder="Optional"
            />
          </div>
          <div style={{ minWidth: 120 }}>
            <TextField
              label="Discount"
              autoComplete="off"
              suffix="%"
              value={discount}
              onChange={setDiscount}
              placeholder="Profile rate"
            />
          </div>
          <div style={{ minWidth: 120 }}>
            <TextField
              label="Min. Order"
              autoComplete="off"
              prefix="$"
              value={minVal}
              onChange={setMinVal}
              placeholder="Default"
            />
          </div>
        </InlineStack>

        <searchFetcher.Form method="post">
          <input type="hidden" name="intent" value="search" />
          <InlineStack gap="300" blockAlign="end" wrap={false}>
            <div style={{ flex: 1 }}>
              <TextField
                label="Search your Shopify customers"
                autoComplete="off"
                name="q"
                value={query}
                onChange={setQuery}
                placeholder="Name or email"
              />
            </div>
            <Button submit loading={searchFetcher.state !== "idle"}>Search</Button>
          </InlineStack>
        </searchFetcher.Form>

        {searched && results.length === 0 && (
          <Text as="p" tone="subdued">No matching Shopify customers.</Text>
        )}

        {results.length > 0 && (
          <BlockStack gap="200">
            {results.map((r) => {
              const name = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
              return (
                <InlineStack key={r.shopifyCustomerId} gap="300" blockAlign="center" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <Text as="span">
                      {name ? `${name} — ` : ""}{r.email ?? "(no email)"}
                    </Text>
                    {r.enrolled && (
                      <Text as="span" tone="subdued">
                        {" "}· already enrolled ({r.enrolled.customerType.toLowerCase()}, {r.enrolled.status.toLowerCase()})
                      </Text>
                    )}
                  </div>
                  {!r.enrolled && r.email && (
                    <enrollFetcher.Form method="post">
                      {settingsInputs}
                      <input type="hidden" name="email" value={r.email} />
                      <input type="hidden" name="firstName" value={r.firstName ?? ""} />
                      <input type="hidden" name="lastName" value={r.lastName ?? ""} />
                      <Button submit size="slim" loading={enrollFetcher.state !== "idle"}>
                        Add as {type.toLowerCase()}
                      </Button>
                    </enrollFetcher.Form>
                  )}
                </InlineStack>
              );
            })}
          </BlockStack>
        )}

        {queryLooksLikeEmail && (
          <enrollFetcher.Form method="post">
            {settingsInputs}
            <input type="hidden" name="email" value={query.trim()} />
            <InlineStack gap="200" blockAlign="center">
              <Button submit size="slim" loading={enrollFetcher.state !== "idle"}>
                Create new customer {query.trim()}
              </Button>
              <Text as="span" tone="subdued" variant="bodySm">
                Creates the Shopify customer record; they sign in with their email — no invite needed.
              </Text>
            </InlineStack>
          </enrollFetcher.Form>
        )}
      </BlockStack>
    </Card>
  );
}

function BackfillCard() {
  const fetcher = useFetcher<{ backfill?: BackfillResult; error?: string }>();
  const r = fetcher.data?.backfill;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Import &amp; Reconcile</Text>
        <Text as="p" tone="subdued">
          Scans every Shopify customer with a wholesale/distributor/b2b tag. Customers the
          app doesn&apos;t know yet are enrolled (needed once after installing on a store
          with existing wholesale accounts); customers it does know get their tags and
          metafields repaired if they&apos;ve drifted. Dry run reports without writing.
        </Text>
        <InlineStack gap="200">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="backfill" />
            <input type="hidden" name="mode" value="dry" />
            <Button submit loading={fetcher.state !== "idle"}>Dry run</Button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="backfill" />
            <input type="hidden" name="mode" value="apply" />
            <Button submit variant="primary" tone="critical" loading={fetcher.state !== "idle"}>
              Apply
            </Button>
          </fetcher.Form>
        </InlineStack>
        {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
        {r && (
          <Banner tone={r.dryRun ? "info" : "success"}>
            <BlockStack gap="100">
              <Text as="p">
                {r.dryRun ? "Dry run — nothing written. " : "Applied. "}
                Scanned {r.scanned} tagged customer{r.scanned === 1 ? "" : "s"}:{" "}
                {r.enrolled.length} {r.dryRun ? "would be " : ""}enrolled,{" "}
                {r.healed.length} {r.dryRun ? "would be " : ""}repaired
                {r.skippedNoEmail > 0 ? `, ${r.skippedNoEmail} skipped (no email)` : ""}.
                {r.truncated ? " WARNING: more customers remain beyond the scan cap." : ""}
              </Text>
              {r.enrolled.length > 0 && (
                <Text as="p" variant="bodySm">
                  Enroll: {r.enrolled.map((e) => `${e.email} (${e.customerType.toLowerCase()})`).join(", ")}
                </Text>
              )}
              {r.healed.length > 0 && (
                <Text as="p" variant="bodySm">
                  Repair: {r.healed.map((h) => `${h.email} — ${h.reason}`).join("; ")}
                </Text>
              )}
            </BlockStack>
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}

export default function CustomersPage() {
  const { customers } = useLoaderData<typeof loader>();
  const [tab, setTab] = useState(0);

  const tabs = [
    { id: "all", content: `All (${customers.length})`, filter: null as string | null },
    {
      id: "wholesale",
      content: `Wholesale (${customers.filter((c) => c.customerType === "WHOLESALE").length})`,
      filter: "WHOLESALE",
    },
    {
      id: "distributor",
      content: `Distributors (${customers.filter((c) => c.customerType === "DISTRIBUTOR").length})`,
      filter: "DISTRIBUTOR",
    },
    {
      id: "b2b",
      content: `B2B (${customers.filter((c) => c.customerType === "B2B").length})`,
      filter: "B2B",
    },
  ];

  const activeFilter = tabs[tab].filter;
  const visible = activeFilter
    ? customers.filter((c) => c.customerType === activeFilter)
    : customers;

  return (
    <Page title="Customers">
      <BlockStack gap="500">
        <AddCustomerCard />

        <Card padding="0">
          <Tabs tabs={tabs} selected={tab} onSelect={setTab}>
            <IndexTable
              resourceName={{ singular: "customer", plural: "customers" }}
              itemCount={visible.length}
              headings={[
                { title: "Name / Company" },
                { title: "Email" },
                { title: "Type" },
                { title: "Status" },
                { title: "Discount" },
                { title: "Terms" },
                { title: "Min. Order" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {visible.map((c, idx) => (
                <CustomerRow key={c.id} customer={c} index={idx} />
              ))}
            </IndexTable>
          </Tabs>
        </Card>

        <BackfillCard />
      </BlockStack>
    </Page>
  );
}
