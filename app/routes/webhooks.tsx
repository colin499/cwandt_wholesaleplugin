import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { resolveDiscountPercent, reconcileCustomerFromWebhook } from "../lib/enrollment.server";

// All Shopify webhook payloads arrive here.
// The authenticate.webhook() call verifies the HMAC signature automatically.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin, payload } =
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
      // Reconcile-only: syncs identity fields and corrects tag drift for
      // known customers. Never enrolls — see reconcileCustomerFromWebhook.
      await reconcileCustomerFromWebhook(payload as Record<string, unknown>, admin);
      break;

    // ── GDPR compliance topics (mandatory) ─────────────────────────────────
    case "CUSTOMERS_DATA_REQUEST": {
      // Merchant has 30 days to provide the customer's data. Log what we
      // hold so the merchant can fulfil the request from the admin.
      const customerId = String((payload as any).customer?.id ?? "");
      const held = customerId
        ? await db.wholesaleCustomer.findUnique({
            where: { shopifyCustomerId: customerId },
            include: { orders: true, application: true },
          })
        : null;
      console.log(
        `[gdpr] customers/data_request for customer ${customerId}: ` +
          (held
            ? `1 account record, ${held.orders.length} order records, ` +
              `${held.application ? 1 : 0} application record`
            : "no data held")
      );
      break;
    }

    case "CUSTOMERS_REDACT": {
      // Erase everything we hold about this customer.
      const customerId = String((payload as any).customer?.id ?? "");
      if (customerId) {
        await db.wholesaleApplication.deleteMany({ where: { shopifyCustomerId: customerId } });
        await db.wholesaleOrder.deleteMany({ where: { shopifyCustomerId: customerId } });
        await db.wholesaleCustomer.deleteMany({ where: { shopifyCustomerId: customerId } });
        console.log(`[gdpr] customers/redact: erased all records for customer ${customerId}`);
      }
      break;
    }

    case "SHOP_REDACT": {
      // Store data erasure request (48h after uninstall). Single-store app:
      // wipe all customer-related data.
      await db.wholesaleApplication.deleteMany({});
      await db.wholesaleOrder.deleteMany({});
      await db.wholesaleCustomer.deleteMany({});
      await db.session.deleteMany({ where: { shop } });
      console.log(`[gdpr] shop/redact: erased all data for ${shop}`);
      break;
    }

    default:
      console.log(`Unhandled webhook topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};

async function handleOrderWebhook(payload: Record<string, unknown>) {
  const shopifyOrderId = String(payload.id ?? "");
  // Tag casing normalizes shop-wide (legacy 'Wholesale' can win) — compare
  // case-insensitively.
  const tags = String(payload.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
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
    ? await db.wholesaleCustomer.findUnique({
        where: { shopifyCustomerId },
        include: { pricingProfile: true },
      })
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
      discountPercent: resolveDiscountPercent(wholesaleCustomer),
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

