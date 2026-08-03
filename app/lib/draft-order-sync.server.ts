/**
 * Draft-order reconciliation — keeps the app's stored copy of a linesheet
 * order in sync with edits made in Shopify Admin.
 *
 * Model: after submission, SHOPIFY is the authority on an order's contents.
 * Every local row is a cache of Shopify state as of a moment, recorded in
 * WholesaleOrder.shopifyUpdatedAt. Webhook delivery is unordered and
 * at-least-once, so every write here is a compare-and-set against that
 * cursor — stale and duplicate deliveries become no-ops, and the app's own
 * draftOrderUpdate echoes reconcile to identical data harmlessly.
 *
 * The customer-facing sheet (LinesheetDraft SUBMITTED row) is derived data:
 * recomposed from the per-order snapshots of both draft orders in a
 * stock + backorder split. It is only recomposed when every referenced order
 * has a line snapshot, so legacy rows created before this machinery existed
 * never have half their lines wiped.
 */

import { db } from "../db.server";

// One stored line of a draft order. variant_id null = custom (non-catalog)
// line staff added in Admin — carried for totals, excluded from sheet lines
// (the linesheet can only render catalog variants).
export type StoredOrderLine = {
  variant_id: number | null;
  quantity: number;
  sku: string;
  title: string;
  unit_price_cents: number;
  total_cents: number;
};

export function parseStoredOrderLines(stored: string | null | undefined): StoredOrderLine[] {
  if (!stored) return [];
  try {
    const raw = JSON.parse(stored);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((l: any) => ({
        variant_id: l?.variant_id == null ? null : Number(l.variant_id),
        quantity: Math.floor(Number(l?.quantity)),
        sku: String(l?.sku ?? ""),
        title: String(l?.title ?? ""),
        unit_price_cents: Math.round(Number(l?.unit_price_cents ?? 0)),
        total_cents: Math.round(Number(l?.total_cents ?? 0)),
      }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
  } catch {
    return [];
  }
}

// Webhook payload line_items → stored lines. REST draft-order shape:
// price is the unit price in dollars, applied_discount.amount is the total
// discount for the whole line.
function linesFromWebhookPayload(payload: Record<string, unknown>): StoredOrderLine[] {
  const items = Array.isArray(payload.line_items) ? (payload.line_items as any[]) : [];
  return items
    .map((li) => {
      const quantity = Math.floor(Number(li?.quantity ?? 0));
      const unitCents = Math.round(Number(li?.price ?? 0) * 100);
      const discountCents = Math.round(Number(li?.applied_discount?.amount ?? 0) * 100);
      const totalCents = Math.max(0, unitCents * quantity - discountCents);
      return {
        variant_id: li?.variant_id == null ? null : Number(li.variant_id),
        quantity,
        sku: String(li?.sku ?? ""),
        title: String(li?.title ?? ""),
        unit_price_cents: quantity > 0 ? Math.round(totalCents / quantity) : 0,
        total_cents: totalCents,
      };
    })
    .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
}

// Recompose the SUBMITTED sheet that references this draft order (as primary
// or backorder half) from the per-order snapshots. Skips quietly when either
// referenced order lacks a snapshot — the sheet keeps its as-submitted lines.
async function recomposeSheetForDraftOrder(draftOrderId: string) {
  const sheet = await db.linesheetDraft.findFirst({
    where: {
      status: "SUBMITTED",
      OR: [
        { shopifyDraftOrderId: draftOrderId },
        { shopifyBackorderDraftOrderId: draftOrderId },
      ],
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!sheet) return;

  const orderIds = [sheet.shopifyDraftOrderId, sheet.shopifyBackorderDraftOrderId].filter(
    (id): id is string => !!id
  );
  const orders = await db.wholesaleOrder.findMany({
    where: { shopifyDraftOrderId: { in: orderIds } },
  });
  if (orders.length !== orderIds.length) return;

  const perOrder = orders.map((o) => parseStoredOrderLines(o.linesJson));
  // A pre-sync row still carries the default "[]" snapshot; recomposing from
  // it would erase that half's lines from the sheet.
  if (perOrder.some((lines) => lines.length === 0)) return;

  const all = perOrder.flat();
  const sheetLines = all
    .filter((l) => l.variant_id != null)
    .map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
  const subtotalCents = all.reduce((sum, l) => sum + l.total_cents, 0);

  await db.linesheetDraft.update({
    where: { id: sheet.id },
    data: { lines: JSON.stringify(sheetLines), subtotalCents },
  });
}

/**
 * DRAFT_ORDERS_UPDATE webhook entry point. Ignores drafts the app didn't
 * create (no WholesaleOrder row) and completed drafts (the real order takes
 * over; orders/updated already maintains it).
 */
export async function reconcileDraftOrderFromWebhook(payload: Record<string, unknown>) {
  const draftOrderId = String(payload.id ?? "");
  if (!draftOrderId) return;

  const status = String(payload.status ?? "");
  if (status === "completed") return;

  const updatedAt = payload.updated_at ? new Date(String(payload.updated_at)) : null;
  if (!updatedAt || isNaN(updatedAt.getTime())) return;

  const lines = linesFromWebhookPayload(payload);
  if (lines.length === 0) return;
  const subtotalCents = lines.reduce((sum, l) => sum + l.total_cents, 0);

  // Atomic compare-and-set on the cursor: applies only if strictly newer
  // than what's stored (null = never reconciled). Returns 0 rows for drafts
  // the app doesn't know, stale deliveries, and duplicates alike.
  const applied = await db.wholesaleOrder.updateMany({
    where: {
      shopifyDraftOrderId: draftOrderId,
      OR: [{ shopifyUpdatedAt: null }, { shopifyUpdatedAt: { lt: updatedAt } }],
    },
    data: {
      linesJson: JSON.stringify(lines),
      totalAmount: subtotalCents,
      shopifyUpdatedAt: updatedAt,
      ...(payload.name ? { orderName: String(payload.name) } : {}),
    },
  });
  if (applied.count === 0) return;

  await recomposeSheetForDraftOrder(draftOrderId);
}
