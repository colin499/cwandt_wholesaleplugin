import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// All Shopify webhook payloads arrive here.
// The authenticate.webhook() call verifies the HMAC signature automatically.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } =
    await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      break;

    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
      await handleOrderWebhook(payload as Record<string, unknown>);
      break;

    case "PRODUCTS_UPDATE":
    case "PRODUCTS_CREATE":
      // placeholder — CMS sync will be wired here in Step 9
      await db.cmsSyncLog.create({
        data: {
          syncType: "PRODUCT",
          direction: "CMS_TO_APP",
          shopifyId: String((payload as any).id ?? ""),
          status: "PENDING",
          payload: JSON.stringify(payload),
        },
      });
      break;

    case "INVENTORY_LEVELS_UPDATE":
      await handleInventoryWebhook(payload as Record<string, unknown>);
      break;

    case "CUSTOMERS_CREATE":
    case "CUSTOMERS_UPDATE":
      await handleCustomerWebhook(payload as Record<string, unknown>);
      break;

    default:
      console.log(`Unhandled webhook topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};

async function handleOrderWebhook(payload: Record<string, unknown>) {
  const shopifyOrderId = String(payload.id ?? "");
  const tags = String(payload.tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const isWholesale = tags.includes("wholesale");
  const isBackorder = tags.includes("backorder");

  // Payment terms: read from order attribute set by the checkout extension,
  // with tag-based fallback for orders placed via other means (e.g. draft orders).
  const noteAttributes = Array.isArray(payload.note_attributes)
    ? (payload.note_attributes as Array<{ name: string; value: string }>)
    : [];
  const paymentTermsAttr = noteAttributes.find((a) => a.name === "_payment_terms")?.value ?? "";
  const isNet30 = tags.includes("net-30") || paymentTermsAttr === "net-30";
  const isNet60 = tags.includes("net-60") || paymentTermsAttr === "net-60";

  if (!isWholesale) return;

  const customer = (payload.customer as Record<string, unknown>) ?? {};
  const shopifyCustomerId = String(customer.id ?? "");

  const wholesaleCustomer = shopifyCustomerId
    ? await db.wholesaleCustomer.findUnique({ where: { shopifyCustomerId } })
    : null;

  if (!wholesaleCustomer) return;

  const paymentTerms = isNet60 ? "NET_60" : isNet30 ? "NET_30" : "CREDIT_CARD";

  await db.wholesaleOrder.upsert({
    where: { shopifyOrderId },
    create: {
      shopifyOrderId,
      orderName: String(payload.name ?? ""),
      shopifyCustomerId,
      paymentTerms: paymentTerms as any,
      totalAmount: Math.round(Number(payload.total_price ?? 0) * 100),
      currency: payload.currency ? String(payload.currency) : null,
      discountPercent: wholesaleCustomer.discountPercent,
      isBackorder,
      orderTags: JSON.stringify(tags),
      status: "CONFIRMED",
      shopifyCreatedAt: payload.created_at
        ? new Date(String(payload.created_at))
        : new Date(),
    },
    update: {
      orderName: String(payload.name ?? ""),
      paymentTerms: paymentTerms as any,
      totalAmount: Math.round(Number(payload.total_price ?? 0) * 100),
      currency: payload.currency ? String(payload.currency) : null,
      isBackorder,
      orderTags: JSON.stringify(tags),
    },
  });

  // Log for CMS sync (Step 9 will wire the actual push)
  await db.cmsSyncLog.create({
    data: {
      syncType: "ORDER",
      direction: "APP_TO_CMS",
      shopifyId: shopifyOrderId,
      status: "PENDING",
      payload: JSON.stringify({ orderName: payload.name, tags }),
    },
  });
}

async function handleInventoryWebhook(payload: Record<string, unknown>) {
  // Record for CMS sync — inventory changes on the Shopify side
  // propagate to the CMS in Step 9
  await db.cmsSyncLog.create({
    data: {
      syncType: "INVENTORY",
      direction: "APP_TO_CMS",
      shopifyId: String(payload.inventory_item_id ?? ""),
      status: "PENDING",
      payload: JSON.stringify(payload),
    },
  });
}

async function handleCustomerWebhook(payload: Record<string, unknown>) {
  const tags = String(payload.tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const shopifyCustomerId = String(payload.id ?? "");
  const isWholesale = tags.includes("wholesale");
  const isDistributor = tags.includes("distributor");

  if (!isWholesale && !isDistributor) return;

  // customerType is DISTRIBUTOR if the customer has the distributor tag.
  // Default discount is 50% for wholesale, 50% for distributor.
  const customerType = isDistributor ? "DISTRIBUTOR" : "WHOLESALE";
  const defaultDiscount = isDistributor ? 50 : 50;

  await db.wholesaleCustomer.upsert({
    where: { shopifyCustomerId },
    create: {
      shopifyCustomerId,
      email: String((payload.email as string) ?? ""),
      firstName: String((payload.first_name as string) ?? ""),
      lastName: String((payload.last_name as string) ?? ""),
      status: "APPROVED",
      customerType,
      discountPercent: defaultDiscount,
      paymentTerms: "CREDIT_CARD",
      approvedAt: new Date(),
    },
    update: {
      email: String((payload.email as string) ?? ""),
      firstName: String((payload.first_name as string) ?? ""),
      lastName: String((payload.last_name as string) ?? ""),
      // Preserve existing customerType — don't downgrade a distributor to wholesale
      // if a webhook fires without the distributor tag (e.g. partial tag updates).
    },
  });
}
