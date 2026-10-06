/**
 * Pick list — print-ready packing sheet for ONE draft order of a submitted
 * order sheet (?order=<draftOrderId>; defaults to the in-stock order).
 *
 * Exists because Shopify has no packing slip for draft orders: quote-first
 * wholesale orders sit as unpaid drafts, and fulfillment needs a list to
 * pack from before a shipping cost can be quoted. Lines come live from the
 * Shopify draft order (the authority after submission — see
 * draft-order-sync.server.ts); the reconciled WholesaleOrder snapshot is the
 * offline fallback.
 *
 * Printing writes the pick list into a throwaway same-origin iframe and
 * prints THAT document — window.print() on the app page itself renders
 * badly inside the embedded-admin iframe (Polaris scroll containers clip
 * the preview).
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, Text, Banner, BlockStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { parseStoredOrderLines } from "../lib/draft-order-sync.server";
import { getUpsConfig } from "../lib/ups.server";

type PickLine = {
  sku: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const sheet = await db.linesheetDraft.findUnique({ where: { id: params.id } });
  if (!sheet) {
    throw new Response("Sheet not found", { status: 404 });
  }

  const customer = await db.wholesaleCustomer.findUnique({
    where: { shopifyCustomerId: sheet.shopifyCustomerId },
    select: {
      email: true, firstName: true, lastName: true, company: true,
      upsAccountNumber: true, upsAccountPostalCode: true, billUpsAccount: true,
    },
  });

  // Which of the sheet's draft orders to print. Anything not matching the
  // backorder half falls back to the in-stock (primary) order.
  const requested = new URL(request.url).searchParams.get("order");
  const isBackorder =
    !!requested && requested === sheet.shopifyBackorderDraftOrderId;
  const targetId = isBackorder
    ? sheet.shopifyBackorderDraftOrderId
    : sheet.shopifyDraftOrderId;

  let lines: PickLine[] = [];
  let source: "live" | "snapshot" | null = null;
  let orderName: string | null = null;
  let addressLines: string[] | null = null;

  if (targetId) {
    try {
      const res = await admin.graphql(
        `#graphql
        query pickListDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            name
            shippingAddress {
              name company address1 address2 city provinceCode zip country phone
            }
            lineItems(first: 250) {
              nodes { sku title variantTitle quantity }
            }
          }
        }`,
        { variables: { id: `gid://shopify/DraftOrder/${targetId}` } }
      );
      const data = await res.json();
      const draftOrder = data.data?.draftOrder;
      if (draftOrder?.lineItems?.nodes?.length) {
        source = "live";
        orderName = draftOrder.name ?? null;
        lines = draftOrder.lineItems.nodes.map((n: any) => ({
          sku: String(n.sku ?? ""),
          title: String(n.title ?? ""),
          variantTitle:
            n.variantTitle && n.variantTitle !== "Default Title" ? String(n.variantTitle) : null,
          quantity: Number(n.quantity ?? 0),
        }));
        const a = draftOrder.shippingAddress;
        if (a) {
          addressLines = [
            a.name,
            a.company,
            a.address1,
            a.address2,
            [a.city, a.provinceCode, a.zip].filter(Boolean).join(", "),
            a.country,
            a.phone,
          ].filter(Boolean);
        }
      }
    } catch (err) {
      console.error("[picklist] draftOrder query failed, using snapshot:", err);
    }

    if (source === null) {
      const order = await db.wholesaleOrder.findUnique({
        where: { shopifyDraftOrderId: targetId },
      });
      const stored = parseStoredOrderLines(order?.linesJson);
      if (stored.length > 0) {
        source = "snapshot";
        orderName = order?.orderName ?? null;
        lines = stored.map((l) => ({
          sku: l.sku,
          title: l.title,
          variantTitle: null,
          quantity: l.quantity,
        }));
      }
    }
  }

  lines.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));

  // Name of the other half of a split submission, so each printout can point
  // at its sibling.
  const otherId = isBackorder
    ? sheet.shopifyDraftOrderId
    : sheet.shopifyBackorderDraftOrderId;
  let otherOrderName: string | null = null;
  if (otherId) {
    const other = await db.wholesaleOrder.findUnique({
      where: { shopifyDraftOrderId: otherId },
      select: { orderName: true },
    });
    otherOrderName = other?.orderName ?? (isBackorder ? "the in-stock order" : "a separate backorder");
  }

  // Customer billed on their own UPS account (Customers → UPS): flag it for
  // the packer, and offer the Ship page when the app's UPS credentials are set.
  const upsBilling =
    customer?.billUpsAccount && customer.upsAccountNumber
      ? { account: customer.upsAccountNumber, postalCode: customer.upsAccountPostalCode }
      : null;
  const shipUrl =
    upsBilling && targetId && sheet.status !== "DRAFT" && getUpsConfig()
      ? `/app/linesheets/${sheet.id}/ship?order=${targetId}`
      : null;

  return json({
    upsBilling,
    shipUrl,
    sheetStatus: sheet.status,
    orderName: orderName ?? sheet.orderName,
    isBackorder,
    poNumber: sheet.poNumber,
    shipOwnLabel: sheet.shipOwnLabel,
    submittedAt: sheet.updatedAt,
    customer,
    lines,
    source,
    addressLines,
    otherOrderName,
  });
};

// Shared by the on-screen view and the print iframe so what prints is what
// you see.
const PICKLIST_CSS = `
  #wh-picklist { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #000; background: #fff; }
  #wh-picklist .pl-head { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
  #wh-picklist h1 { font-size: 22px; margin: 0 0 4px; }
  #wh-picklist .pl-meta { font-size: 13px; line-height: 1.5; }
  #wh-picklist .pl-address { font-size: 13px; line-height: 1.5; text-align: right; }
  #wh-picklist .pl-flag { display: inline-block; border: 2px solid #000; padding: 2px 8px; font-weight: 700; font-size: 13px; margin-top: 6px; }
  #wh-picklist table { width: 100%; border-collapse: collapse; font-size: 14px; }
  #wh-picklist th { text-align: left; border-bottom: 2px solid #000; padding: 6px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  #wh-picklist td { border-bottom: 1px solid #ccc; padding: 10px 8px; vertical-align: top; }
  #wh-picklist .pl-check { width: 28px; }
  #wh-picklist .pl-check span { display: inline-block; width: 16px; height: 16px; border: 1.5px solid #000; }
  #wh-picklist .pl-qty { text-align: right; font-weight: 700; font-size: 16px; white-space: nowrap; }
  #wh-picklist .pl-sku { white-space: nowrap; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  #wh-picklist tfoot td { border-bottom: none; border-top: 2px solid #000; font-weight: 700; }
  #wh-picklist .pl-note { margin-top: 14px; font-size: 13px; }
  #wh-picklist .pl-fill { display: flex; gap: 32px; flex-wrap: wrap; margin-top: 28px; font-size: 13px; }
  #wh-picklist .pl-fill span { display: inline-block; border-bottom: 1px solid #000; min-width: 120px; height: 1.2em; }
`;

function printPickList(title: string) {
  const el = document.getElementById("wh-picklist");
  if (!el) return;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>" +
      title.replace(/</g, "&lt;") +
      "</title><style>" +
      PICKLIST_CSS +
      " body { margin: 24px; }</style></head><body>" +
      el.outerHTML +
      "</body></html>"
  );
  doc.close();
  // Removing too early cancels the dialog in some browsers; afterprint plus
  // a long fallback covers both.
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    setTimeout(() => iframe.remove(), 500);
  };
  win.onafterprint = cleanup;
  setTimeout(cleanup, 120000);
  win.focus();
  win.print();
}

export default function PickListPage() {
  const data = useLoaderData<typeof loader>();
  const {
    orderName, isBackorder, poNumber, shipOwnLabel, customer, lines, source,
    addressLines, otherOrderName, sheetStatus, submittedAt, upsBilling, shipUrl,
  } = data;

  const customerName =
    customer?.company ||
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") ||
    customer?.email ||
    "Unknown customer";
  const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);
  const pageTitle = `Pick list ${orderName ?? ""}`.trim();

  return (
    <Page
      title={pageTitle}
      titleMetadata={isBackorder ? <Text as="span" tone="critical" fontWeight="bold">BACKORDER</Text> : undefined}
      backAction={{ content: "Order Sheets", url: "/app/linesheets" }}
      primaryAction={{ content: "Print", onAction: () => printPickList(pageTitle) }}
      secondaryActions={shipUrl ? [{ content: "Ship with UPS", url: shipUrl }] : undefined}
    >
      <BlockStack gap="400">
        {sheetStatus === "DRAFT" && (
          <Banner tone="warning" title="Not submitted yet">
            <Text as="p">
              This sheet is still a customer draft — there is no order to pack.
            </Text>
          </Banner>
        )}
        {source === "snapshot" && (
          <Banner tone="info">
            <Text as="p">
              Couldn't reach Shopify just now — showing the last synced copy of this order.
            </Text>
          </Banner>
        )}
        {source !== null && (
          <Card>
            <div id="wh-picklist">
              <style>{PICKLIST_CSS}</style>
              <div className="pl-head">
                <div>
                  <h1>Pick list — {orderName ?? "order"}</h1>
                  <div className="pl-meta">
                    <div>{customerName}</div>
                    {customer?.email && <div>{customer.email}</div>}
                    {poNumber && <div>PO: {poNumber}</div>}
                    <div>Submitted {new Date(submittedAt).toLocaleDateString()}</div>
                    {isBackorder && <div className="pl-flag">BACKORDER — SHIPS WHEN STOCK IS AVAILABLE</div>}
                    {shipOwnLabel && <div className="pl-flag">CUSTOMER PROVIDES SHIPPING LABEL</div>}
                    {upsBilling && !shipOwnLabel && (
                      <div className="pl-flag">
                        BILL CUSTOMER'S UPS ACCOUNT {upsBilling.account}
                        {upsBilling.postalCode && ` · ZIP ${upsBilling.postalCode}`}
                      </div>
                    )}
                  </div>
                </div>
                {addressLines && (
                  <div className="pl-address">
                    <strong>Ship to</strong>
                    {addressLines.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th className="pl-check"></th>
                    <th>SKU</th>
                    <th>Item</th>
                    <th className="pl-qty">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="pl-check"><span /></td>
                      <td className="pl-sku">{l.sku || "—"}</td>
                      <td>
                        {l.title}
                        {l.variantTitle && ` — ${l.variantTitle}`}
                      </td>
                      <td className="pl-qty">{l.quantity}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td></td>
                    <td colSpan={2}>{lines.length} lines</td>
                    <td className="pl-qty">{totalUnits}</td>
                  </tr>
                </tfoot>
              </table>
              {otherOrderName && !isBackorder && (
                <p className="pl-note">
                  This order has a {otherOrderName} for out-of-stock items. Those are not on
                  this list — pack only what's above.
                </p>
              )}
              {otherOrderName && isBackorder && (
                <p className="pl-note">
                  This is the backorder half of a split order. In-stock items are on {otherOrderName}.
                </p>
              )}
              <div className="pl-fill">
                <div>Weight: <span /></div>
                <div>Shipping cost: <span /></div>
                <div>Packed by: <span /></div>
                <div>Date: <span /></div>
              </div>
            </div>
          </Card>
        )}
        {source === null && sheetStatus !== "DRAFT" && (
          <Banner tone="critical" title="No order lines found">
            <Text as="p">
              Couldn't load lines from Shopify and no synced copy exists for this sheet.
            </Text>
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}
