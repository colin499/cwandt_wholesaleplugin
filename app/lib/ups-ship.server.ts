/**
 * Server side of the admin "Ship with UPS" pages — buying a UPS label for a
 * Shopify order or draft order, billed to the customer's UPS account on file
 * (Customers → UPS).
 *
 * Two routes share this:
 *   /app/linesheets/:id/ship        an order sheet's draft order (from the pick list)
 *   /app/shipping/:kind/:id         any order / draft order (e.g. one staff
 *                                   created by hand in Shopify Admin)
 *
 * Deliberately isolated from the ordering flow: it only READS Shopify and the
 * customer / sheet rows, and writes only UpsShipment rows. It never edits an
 * order or draft order, so draft-order sync and the customer-facing pages are
 * unaffected.
 */
import { json } from "@remix-run/node";
import type { LinesheetDraft, UpsShipment } from "@prisma/client";
import { db } from "../db.server";
import { upsServiceLabel } from "./ups-services";
import {
  UpsError,
  createUpsShipment,
  getUpsConfig,
  rateUpsShipment,
  validateRateInput,
  validateShipmentInput,
  voidUpsShipment,
  type UpsAddress,
  type UpsBillingType,
  type UpsCharge,
  type UpsPackageInput,
  type UpsPackageResult,
} from "./ups.server";

/** Minimal shape of the Admin GraphQL client from authenticate.admin(). */
type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<{ json: () => Promise<any> }>;
};

// What a label is bought against. Ids are numeric Shopify ids as strings.
export type ShipTarget = { kind: "DRAFT" | "ORDER"; id: string };

type StoredPackage = UpsPackageResult & { weightLbs: number };

// One line of the order, for the packing slip.
export type ShipLine = {
  sku: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
};

type ShopifyShipOrder = {
  name: string | null;
  poNumber: string | null;
  customerId: string | null;
  shipTo: UpsAddress | null;
  cancelled: boolean;
  // A draft order's completed order, once it has one.
  linkedOrderId: string | null;
  lines: ShipLine[];
};

// Shopify withholds address fields from apps that haven't been granted them
// under "Protected customer data access" — a setup problem, not an outage.
const ADDRESS_ACCESS_MESSAGE =
  "Shopify isn't letting this app read shipping addresses. In the app's API access " +
  "settings, under Protected customer data access, enable the Name, Address and Phone fields.";

function isAddressAccessError(err: unknown): boolean {
  return err instanceof Error && /not approved to use/i.test(err.message);
}

const SHIP_FIELDS = `
  name
  poNumber
  customer { legacyResourceId }
  shippingAddress {
    name company address1 address2 city provinceCode zip countryCodeV2 phone
  }
  lineItems(first: 250) {
    nodes { sku title variantTitle quantity }
  }
`;

// Returns null when Shopify has no such order.
async function loadShopifyOrder(
  admin: AdminClient,
  target: ShipTarget
): Promise<ShopifyShipOrder | null> {
  const res =
    target.kind === "DRAFT"
      ? await admin.graphql(
          `#graphql
          query shipDraftOrder($id: ID!) {
            draftOrder(id: $id) { ${SHIP_FIELDS} order { legacyResourceId } }
          }`,
          { variables: { id: `gid://shopify/DraftOrder/${target.id}` } }
        )
      : await admin.graphql(
          `#graphql
          query shipOrder($id: ID!) {
            order(id: $id) { ${SHIP_FIELDS} cancelledAt }
          }`,
          { variables: { id: `gid://shopify/Order/${target.id}` } }
        );
  const data = await res.json();
  const node = target.kind === "DRAFT" ? data.data?.draftOrder : data.data?.order;
  if (!node) return null;

  const a = node.shippingAddress;
  const lines: ShipLine[] = (node.lineItems?.nodes ?? [])
    .map((n: any) => ({
      sku: String(n.sku ?? ""),
      title: String(n.title ?? ""),
      variantTitle:
        n.variantTitle && n.variantTitle !== "Default Title" ? String(n.variantTitle) : null,
      quantity: Number(n.quantity ?? 0),
    }))
    .filter((l: ShipLine) => l.quantity > 0)
    .sort((x: ShipLine, y: ShipLine) => x.sku.localeCompare(y.sku, undefined, { numeric: true }));
  return {
    name: node.name ?? null,
    poNumber: node.poNumber ?? null,
    customerId: node.customer?.legacyResourceId ? String(node.customer.legacyResourceId) : null,
    cancelled: !!node.cancelledAt,
    linkedOrderId: node.order?.legacyResourceId ? String(node.order.legacyResourceId) : null,
    lines,
    shipTo: a
      ? {
          name: a.company || a.name || "",
          attention: a.name || a.company || "",
          phone: a.phone ?? null,
          address1: a.address1 ?? "",
          address2: a.address2 ?? null,
          city: a.city ?? "",
          state: a.provinceCode ?? "",
          postalCode: a.zip ?? "",
          countryCode: a.countryCodeV2 ?? "",
        }
      : null,
  };
}

// Every UpsShipment that belongs to this order — including labels bought
// against its draft before it became an order (and vice versa), where the
// link is known.
async function shipmentFilter(target: ShipTarget, linkedOrderId: string | null) {
  if (target.kind === "DRAFT") {
    return {
      OR: [
        { shopifyDraftOrderId: target.id },
        ...(linkedOrderId ? [{ shopifyOrderId: linkedOrderId }] : []),
      ],
    };
  }
  const fromSheet = await db.wholesaleOrder.findUnique({
    where: { shopifyOrderId: target.id },
    select: { shopifyDraftOrderId: true },
  });
  return {
    OR: [
      { shopifyOrderId: target.id },
      ...(fromSheet?.shopifyDraftOrderId
        ? [{ shopifyDraftOrderId: fromSheet.shopifyDraftOrderId }]
        : []),
    ],
  };
}

function parseStoredPackages(raw: string): StoredPackage[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function shipmentView(s: UpsShipment) {
  return {
    id: s.id,
    status: s.status,
    environment: s.environment,
    shipmentId: s.shipmentId,
    serviceLabel: upsServiceLabel(s.serviceCode),
    billedAccount: s.billedAccount,
    createdAt: s.createdAt.toISOString(),
    estimatedCharge:
      s.estimatedCharge && s.estimatedCurrency
        ? ({ amount: s.estimatedCharge, currency: s.estimatedCurrency } as UpsCharge)
        : null,
    // Label images only for live shipments — a voided label must not be reprinted.
    packages: parseStoredPackages(s.packagesJson).map((p) => ({
      trackingNumber: p.trackingNumber,
      weightLbs: p.weightLbs,
      labelFormat: p.labelFormat,
      labelBase64: s.status === "ACTIVE" ? p.labelBase64 : "",
    })),
  };
}

const CUSTOMER_SELECT = {
  email: true,
  firstName: true,
  lastName: true,
  company: true,
  upsAccountNumber: true,
  upsAccountPostalCode: true,
  upsAccountCountry: true,
  billUpsAccount: true,
} as const;

/**
 * Everything the Ship page shows. `sheet` is set on the order-sheet route:
 * the sheet then names the customer and PO (its draft order is the app's
 * own). Without it, both come from the Shopify order.
 */
export async function loadShipPage(
  admin: AdminClient,
  target: ShipTarget | null,
  sheet: LinesheetDraft | null = null
) {
  const config = getUpsConfig();

  let order: ShopifyShipOrder | null = null;
  let addressError: "ACCESS" | "OTHER" | null = null;
  let notFound = false;
  if (target) {
    try {
      order = await loadShopifyOrder(admin, target);
      notFound = order === null;
    } catch (err) {
      console.error("[ship] order query failed:", err);
      addressError = isAddressAccessError(err) ? "ACCESS" : "OTHER";
    }
  }

  const shopifyCustomerId = sheet?.shopifyCustomerId ?? order?.customerId ?? null;
  const customer = shopifyCustomerId
    ? await db.wholesaleCustomer.findUnique({
        where: { shopifyCustomerId },
        select: CUSTOMER_SELECT,
      })
    : null;

  const rows = target
    ? await db.upsShipment.findMany({
        where: await shipmentFilter(target, order?.linkedOrderId ?? null),
        orderBy: { createdAt: "desc" },
      })
    : [];

  return {
    target,
    orderName: order?.name ?? sheet?.orderName ?? null,
    poNumber: sheet?.poNumber ?? order?.poNumber ?? null,
    shipTo: order?.shipTo ?? null,
    lines: order?.lines ?? [],
    // Printed at the top of the packing slip. Address only — no credentials.
    shipFrom: config
      ? {
          name: config.shipFrom.name,
          address1: config.shipFrom.address1,
          address2: config.shipFrom.address2 ?? null,
          city: config.shipFrom.city,
          state: config.shipFrom.state,
          postalCode: config.shipFrom.postalCode,
          phone: config.shipFrom.phone ?? null,
        }
      : null,
    addressError,
    addressAccessMessage: ADDRESS_ACCESS_MESSAGE,
    notFound,
    cancelled: order?.cancelled ?? false,
    // An order sheet the customer hasn't submitted has nothing to ship.
    notSubmitted: sheet?.status === "DRAFT",
    upsEnabled: config !== null,
    environment: config?.environment ?? null,
    customer: customer
      ? {
          name:
            customer.company ||
            [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
            customer.email,
          upsAccountNumber: customer.upsAccountNumber,
          upsAccountPostalCode: customer.upsAccountPostalCode,
          billUpsAccount: customer.billUpsAccount,
        }
      : null,
    shipments: rows.map(shipmentView),
  };
}

export type ShipPageData = Awaited<ReturnType<typeof loadShipPage>>;

function parsePackages(raw: string): UpsPackageInput[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const num = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  return parsed.map((p: any) => ({
    weightLbs: num(p?.weight) ?? NaN,
    lengthIn: num(p?.length),
    widthIn: num(p?.width),
    heightIn: num(p?.height),
  }));
}

// Every error is returned as a 4xx: gateways in front of the app (the dev
// tunnel, for one) swap 502-class responses for their own error page, which
// would hide the message from the Ship page.
const fail = (error: string, status = 400) => json({ error }, { status });

/** Ship page form posts: intent "buy" | "void". */
export async function handleShipAction(
  admin: AdminClient,
  formData: FormData,
  target: ShipTarget | null,
  sheet: LinesheetDraft | null = null
) {
  const intent = String(formData.get("intent"));

  const config = getUpsConfig();
  if (!config) return fail("UPS is not configured for this app.");
  if (!target) return fail("There is no order to ship.");

  // ── Void a label ───────────────────────────────────────────────────────────
  if (intent === "void") {
    let linkedOrderId: string | null = null;
    if (target.kind === "DRAFT") {
      try {
        linkedOrderId = (await loadShopifyOrder(admin, target))?.linkedOrderId ?? null;
      } catch {
        // Best effort — the draft's own labels are still matched by draft id.
      }
    }
    const shipment = await db.upsShipment.findFirst({
      where: {
        AND: [
          { id: String(formData.get("shipmentId")) },
          await shipmentFilter(target, linkedOrderId),
        ],
      },
    });
    if (!shipment) return fail("Shipment not found", 404);
    if (shipment.status !== "ACTIVE") return fail("Already voided.");
    if (shipment.environment !== config.environment) {
      return fail(
        `This label was created in ${shipment.environment} mode and can't be voided from ${config.environment} mode.`
      );
    }
    try {
      await voidUpsShipment(config, shipment.shipmentId);
    } catch (err) {
      console.error("[ship] void failed:", err);
      return fail(err instanceof UpsError ? `UPS: ${err.message}` : "Couldn't void the label.");
    }
    await db.upsShipment.update({
      where: { id: shipment.id },
      data: { status: "VOIDED", voidedAt: new Date() },
    });
    return json({ ok: true, voided: true });
  }

  // ── Quote rates ────────────────────────────────────────────────────────────
  // Every offered service for the entered packages, so staff can see the
  // price before buying. An estimate at CW&T's rates: the customer's account
  // is billed at its own rates.
  if (intent === "rate") {
    let order: ShopifyShipOrder | null;
    try {
      order = await loadShopifyOrder(admin, target);
    } catch (err) {
      console.error("[ship] order query failed:", err);
      return fail(
        isAddressAccessError(err)
          ? ADDRESS_ACCESS_MESSAGE
          : "Couldn't load the order from Shopify. Try again."
      );
    }
    if (!order) return fail("Shopify has no such order.", 404);
    if (!order.shipTo) return fail("The order has no shipping address in Shopify.");

    const packages = parsePackages(String(formData.get("packages") ?? ""));
    if (!packages) return fail("Invalid package details.");
    const input = { shipTo: order.shipTo, packages };
    const invalid = validateRateInput(input);
    if (invalid) return fail(invalid);

    try {
      const quotes = await rateUpsShipment(config, input);
      return json({
        ok: true,
        rates: quotes.map((q) => ({ ...q, label: upsServiceLabel(q.serviceCode) })),
      });
    } catch (err) {
      console.error("[ship] rate quote failed:", err);
      if (err instanceof UpsError && err.code === "250002") {
        return fail(
          "UPS won't quote rates for this app yet. In the UPS Developer Portal, add the " +
            "Rating API to the app (My Apps → the app → Add Products). Labels still work."
        );
      }
      return fail(err instanceof UpsError ? `UPS: ${err.message}` : "Couldn't get rates from UPS.");
    }
  }

  // ── Buy a label ────────────────────────────────────────────────────────────
  if (intent === "buy") {
    if (sheet?.status === "DRAFT") {
      return fail("This sheet hasn't been submitted — there is no order to ship.");
    }

    let order: ShopifyShipOrder | null;
    try {
      order = await loadShopifyOrder(admin, target);
    } catch (err) {
      console.error("[ship] order query failed:", err);
      return fail(
        isAddressAccessError(err)
          ? ADDRESS_ACCESS_MESSAGE
          : "Couldn't load the order from Shopify. Try again."
      );
    }
    if (!order) return fail("Shopify has no such order.", 404);
    if (order.cancelled) return fail("This order is cancelled.");
    if (!order.shipTo) return fail("The order has no shipping address in Shopify.");

    // Billing details always come from the customer row, never from the form.
    const shopifyCustomerId = sheet?.shopifyCustomerId ?? order.customerId;
    const customer = shopifyCustomerId
      ? await db.wholesaleCustomer.findUnique({ where: { shopifyCustomerId } })
      : null;
    if (!customer?.billUpsAccount || !customer.upsAccountNumber || !customer.upsAccountPostalCode) {
      return fail(
        "This customer isn't set up to be billed on their UPS account (Customers → UPS)."
      );
    }

    // A second label is a second charge to the customer — make it deliberate.
    const existing = await db.upsShipment.count({
      where: { AND: [{ status: "ACTIVE" }, await shipmentFilter(target, order.linkedOrderId)] },
    });
    if (existing > 0 && String(formData.get("additional")) !== "true") {
      return fail(
        "This order already has a label. Void it, or confirm that it needs an additional one."
      );
    }

    const packages = parsePackages(String(formData.get("packages") ?? ""));
    if (!packages) return fail("Invalid package details.");

    const serviceCode = String(formData.get("serviceCode") ?? "");
    const billingType: UpsBillingType =
      String(formData.get("billingType")) === "THIRD_PARTY" ? "THIRD_PARTY" : "RECEIVER";
    // The quote the page showed for this service, if staff fetched one.
    // Display-only, so it is taken as sent (after a shape check).
    const estimatedAmount = String(formData.get("estimatedAmount") ?? "").trim();
    const estimatedCurrency = String(formData.get("estimatedCurrency") ?? "").trim().toUpperCase();
    const estimate =
      /^\d+(\.\d+)?$/.test(estimatedAmount) && /^[A-Z]{3}$/.test(estimatedCurrency)
        ? { amount: estimatedAmount, currency: estimatedCurrency }
        : null;
    const orderName = order.name ?? sheet?.orderName ?? null;
    const poNumber = sheet?.poNumber ?? order.poNumber;

    const shipment = {
      shipTo: order.shipTo,
      packages,
      serviceCode,
      billing: {
        type: billingType,
        accountNumber: customer.upsAccountNumber,
        postalCode: customer.upsAccountPostalCode,
        countryCode: customer.upsAccountCountry || "US",
      },
      reference: [orderName, poNumber ? `PO ${poNumber}` : null].filter(Boolean).join(" "),
    };
    // Our own form checks first, so they aren't reported as coming from UPS.
    const invalid = validateShipmentInput(shipment);
    if (invalid) return fail(invalid);

    let result: Awaited<ReturnType<typeof createUpsShipment>>;
    try {
      result = await createUpsShipment(config, shipment);
    } catch (err) {
      console.error("[ship] label purchase failed:", err);
      return fail(err instanceof UpsError ? `UPS: ${err.message}` : "Couldn't buy the label.");
    }

    const stored: StoredPackage[] = result.packages.map((p, i) => ({
      ...p,
      weightLbs: packages[i]?.weightLbs ?? 0,
    }));
    try {
      await db.upsShipment.create({
        data: {
          sheetId: sheet?.id ?? null,
          shopifyDraftOrderId: target.kind === "DRAFT" ? target.id : null,
          shopifyOrderId: target.kind === "ORDER" ? target.id : order.linkedOrderId,
          shopifyCustomerId: customer.shopifyCustomerId,
          orderName,
          environment: config.environment,
          shipmentId: result.shipmentId,
          serviceCode,
          billingType,
          billedAccount: customer.upsAccountNumber,
          packagesJson: JSON.stringify(stored),
          estimatedCharge: estimate?.amount ?? null,
          estimatedCurrency: estimate?.currency ?? null,
          upsTotalCharge: result.totalCharge?.amount ?? null,
        },
      });
    } catch (err) {
      // The label exists at UPS but we failed to record it — say so loudly,
      // with the tracking numbers, so it can be voided or used by hand.
      console.error("[ship] label bought but not saved:", result.shipmentId, err);
      return fail(
        `The label was created at UPS (${result.packages.map((p) => p.trackingNumber).join(", ")}) ` +
          "but couldn't be saved here. Void it on ups.com or contact support before buying another."
      );
    }
    return json({ ok: true, bought: true });
  }

  return fail("Unknown intent");
}

// ── Orders waiting to ship for customers billed on their UPS account ─────────

export type ShippableRow = {
  kind: "DRAFT" | "ORDER";
  id: string;
  name: string;
  customerName: string;
  createdAt: string;
  status: string;
  hasAddress: boolean;
  labels: number;
  // Sum of the labels' rate estimates, when every label has one.
  estimatedTotal: UpsCharge | null;
};

function shippableRow(kind: "DRAFT" | "ORDER", n: any): ShippableRow {
  return {
    kind,
    id: String(n.legacyResourceId),
    name: String(n.name ?? ""),
    customerName: n.customer?.displayName ?? "No customer",
    createdAt: String(n.createdAt ?? ""),
    status:
      kind === "DRAFT"
        ? n.status === "INVOICE_SENT"
          ? "Draft — invoice sent"
          : "Draft"
        : n.displayFulfillmentStatus === "PARTIALLY_FULFILLED"
          ? "Partially fulfilled"
          : "Unfulfilled",
    hasAddress: !!n.shippingAddress,
    labels: 0,
    estimatedTotal: null,
  };
}

const LIST_FIELDS = `
  legacyResourceId name createdAt
  customer { displayName }
  shippingAddress { countryCodeV2 }
`;

/**
 * Open draft orders and unfulfilled orders in Shopify — either for the
 * customers flagged "bill this account" (default), or matching a typed order
 * number. Includes orders staff created by hand in Shopify Admin: nothing
 * here depends on the order sheet.
 */
export async function listShippableOrders(admin: AdminClient, search: string) {
  const billable = await db.wholesaleCustomer.findMany({
    where: { billUpsAccount: true, upsAccountNumber: { not: null } },
    select: { shopifyCustomerId: true },
    take: 100,
  });

  const term = search.trim().replace(/^#/, "");
  let orderQuery: string;
  let draftQuery: string;
  if (term) {
    // Draft orders have no name: filter — plain text search matches "#D12".
    orderQuery = `name:${JSON.stringify(term)}`;
    draftQuery = `#${term}`;
  } else {
    if (billable.length === 0) return { rows: [] as ShippableRow[], billableCount: 0, error: null };
    const who = billable.map((c) => `customer_id:${c.shopifyCustomerId}`).join(" OR ");
    orderQuery = `fulfillment_status:unfulfilled AND status:open AND (${who})`;
    draftQuery = `(status:open OR status:invoice_sent) AND (${who})`;
  }

  let rows: ShippableRow[] = [];
  let error: "ACCESS" | "OTHER" | null = null;
  try {
    const res = await admin.graphql(
      `#graphql
      query shippableOrders($orderQuery: String!, $draftQuery: String!) {
        orders(first: 50, sortKey: CREATED_AT, reverse: true, query: $orderQuery) {
          nodes { ${LIST_FIELDS} displayFulfillmentStatus cancelledAt }
        }
        draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true, query: $draftQuery) {
          nodes { ${LIST_FIELDS} status }
        }
      }`,
      { variables: { orderQuery, draftQuery } }
    );
    const data = await res.json();
    rows = [
      ...(data.data?.orders?.nodes ?? [])
        .filter((n: any) => !n.cancelledAt)
        .map((n: any) => shippableRow("ORDER", n)),
      // A completed draft is shipped as its order, not as the draft.
      ...(data.data?.draftOrders?.nodes ?? [])
        .filter((n: any) => n.status !== "COMPLETED")
        .map((n: any) => shippableRow("DRAFT", n)),
    ];
  } catch (err) {
    console.error("[shipping] order list failed:", err);
    error = isAddressAccessError(err) ? "ACCESS" : "OTHER";
  }

  if (rows.length > 0) {
    const labels = await db.upsShipment.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { shopifyOrderId: { in: rows.filter((r) => r.kind === "ORDER").map((r) => r.id) } },
          { shopifyDraftOrderId: { in: rows.filter((r) => r.kind === "DRAFT").map((r) => r.id) } },
        ],
      },
      select: {
        shopifyOrderId: true,
        shopifyDraftOrderId: true,
        estimatedCharge: true,
        estimatedCurrency: true,
      },
    });
    for (const r of rows) {
      const mine = labels.filter((l) =>
        r.kind === "ORDER" ? l.shopifyOrderId === r.id : l.shopifyDraftOrderId === r.id
      );
      r.labels = mine.length;
      const currency = mine[0]?.estimatedCurrency ?? null;
      if (
        mine.length > 0 &&
        currency &&
        mine.every((l) => l.estimatedCharge && l.estimatedCurrency === currency)
      ) {
        const cents = mine.reduce((sum, l) => sum + Math.round(Number(l.estimatedCharge) * 100), 0);
        r.estimatedTotal = { amount: (cents / 100).toFixed(2), currency };
      }
    }
  }

  return { rows, billableCount: billable.length, error };
}
