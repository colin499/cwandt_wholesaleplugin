import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Modal,
  TextContainer,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const applications = await db.wholesaleApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return json({ applications });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const applicationId = String(formData.get("applicationId"));
  const intent = String(formData.get("intent")); // "approve" | "reject"

  const application = await db.wholesaleApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    return json({ error: "Application not found" }, { status: 404 });
  }

  if (intent === "approve") {
    // 1. Find or create Shopify customer
    const customerResponse = await admin.graphql(`
      query findCustomer($email: String!) {
        customers(first: 1, query: $email) {
          edges { node { id legacyResourceId tags } }
        }
      }
    `, { variables: { email: `email:${application.email}` } });

    const customerData = await customerResponse.json();
    const existingCustomer = customerData.data?.customers?.edges?.[0]?.node;

    let shopifyCustomerId: string;

    // Metafield written on approve so the checkout extension can read wholesale status
    // without a network call. namespace/key must match shopify.extension.toml.
    const wholesaleStatusMetafield = {
      namespace: "wholesale",
      key: "status",
      value: "approved",
      type: "single_line_text_field",
    };

    if (existingCustomer) {
      shopifyCustomerId = existingCustomer.legacyResourceId;
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
            id: existingCustomer.id,
            tags: [...(existingCustomer.tags || []), "wholesale"],
            metafields: [wholesaleStatusMetafield],
          },
        },
      });
    } else {
      // Create new Shopify customer with wholesale tag
      const createResponse = await admin.graphql(`
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id legacyResourceId }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          input: {
            email: application.email,
            firstName: application.firstName,
            lastName: application.lastName,
            tags: ["wholesale"],
            metafields: [wholesaleStatusMetafield],
          },
        },
      });

      const createData = await createResponse.json();
      shopifyCustomerId =
        createData.data?.customerCreate?.customer?.legacyResourceId ?? "";
    }

    // 2. Create WholesaleCustomer record
    await db.wholesaleCustomer.upsert({
      where: { shopifyCustomerId },
      create: {
        shopifyCustomerId,
        email: application.email,
        firstName: application.firstName,
        lastName: application.lastName,
        company: application.company,
        phone: application.phone ?? undefined,
        status: "APPROVED",
        discountPercent: 50,
        paymentTerms: "CREDIT_CARD",
        approvedAt: new Date(),
      },
      update: {
        status: "APPROVED",
        approvedAt: new Date(),
      },
    });

    // 3. Mark application approved
    await db.wholesaleApplication.update({
      where: { id: applicationId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        shopifyCustomerId,
      },
    });
  } else {
    await db.wholesaleApplication.update({
      where: { id: applicationId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
      },
    });
  }

  return json({ ok: true });
};

export default function ApplicationsPage() {
  const { applications } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const pending = applications.filter((a) => a.status === "PENDING");
  const reviewed = applications.filter((a) => a.status !== "PENDING");

  return (
    <Page title="Wholesale Applications">
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Pending Review ({pending.length})
            </Text>
            <IndexTable
              resourceName={{ singular: "application", plural: "applications" }}
              itemCount={pending.length}
              headings={[
                { title: "Company" },
                { title: "Contact" },
                { title: "Email" },
                { title: "Submitted" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {pending.map((app, idx) => (
                <IndexTable.Row id={app.id} key={app.id} position={idx}>
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="semibold">{app.company}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {app.firstName} {app.lastName}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{app.email}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {new Date(app.createdAt).toLocaleDateString()}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200">
                      <fetcher.Form method="post">
                        <input type="hidden" name="applicationId" value={app.id} />
                        <input type="hidden" name="intent" value="approve" />
                        <Button tone="success" submit size="slim">Approve</Button>
                      </fetcher.Form>
                      <fetcher.Form method="post">
                        <input type="hidden" name="applicationId" value={app.id} />
                        <input type="hidden" name="intent" value="reject" />
                        <Button tone="critical" submit size="slim">Reject</Button>
                      </fetcher.Form>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Previously Reviewed ({reviewed.length})
            </Text>
            <IndexTable
              resourceName={{ singular: "application", plural: "applications" }}
              itemCount={reviewed.length}
              headings={[
                { title: "Company" },
                { title: "Email" },
                { title: "Status" },
                { title: "Reviewed" },
              ]}
              selectable={false}
            >
              {reviewed.map((app, idx) => (
                <IndexTable.Row id={app.id} key={app.id} position={idx}>
                  <IndexTable.Cell>{app.company}</IndexTable.Cell>
                  <IndexTable.Cell>{app.email}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={app.status === "APPROVED" ? "success" : "critical"}>
                      {app.status}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {app.reviewedAt
                      ? new Date(app.reviewedAt).toLocaleDateString()
                      : "—"}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
