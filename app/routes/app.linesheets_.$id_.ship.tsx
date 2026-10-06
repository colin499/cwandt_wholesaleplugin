/**
 * Ship with UPS — for ONE draft order of a submitted order sheet
 * (?order=<draftOrderId>; defaults to the in-stock order). Reached from the
 * pick list. The label is billed to the customer's UPS account on file.
 *
 * Page body and all logic are shared with /app/shipping/:kind/:id — see
 * app/lib/ups-ship.server.ts and app/components/UpsShipPage.tsx.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { handleShipAction, loadShipPage, type ShipTarget } from "../lib/ups-ship.server";
import { UpsShipPage } from "../components/UpsShipPage";

// The sheet's draft order this page ships: the backorder half only when it is
// asked for by id, otherwise the in-stock (primary) order — same rule as the
// pick list.
function sheetTarget(
  sheet: { shopifyDraftOrderId: string | null; shopifyBackorderDraftOrderId: string | null },
  request: Request
): ShipTarget | null {
  const requested = new URL(request.url).searchParams.get("order");
  const id =
    requested && requested === sheet.shopifyBackorderDraftOrderId
      ? sheet.shopifyBackorderDraftOrderId
      : sheet.shopifyDraftOrderId;
  return id ? { kind: "DRAFT", id } : null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const sheet = await db.linesheetDraft.findUnique({ where: { id: params.id } });
  if (!sheet) {
    throw new Response("Sheet not found", { status: 404 });
  }

  const target = sheetTarget(sheet, request);
  return json({
    ...(await loadShipPage(admin, target, sheet)),
    sheetId: sheet.id,
    isBackorder: !!target && target.id === sheet.shopifyBackorderDraftOrderId,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const sheet = await db.linesheetDraft.findUnique({ where: { id: params.id } });
  if (!sheet) return json({ error: "Sheet not found" }, { status: 404 });

  return handleShipAction(admin, await request.formData(), sheetTarget(sheet, request), sheet);
};

export default function SheetShipPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <UpsShipPage
      data={data}
      flag={data.isBackorder ? "BACKORDER" : null}
      backAction={{
        content: "Pick list",
        url: `/app/linesheets/${data.sheetId}${data.target ? `?order=${data.target.id}` : ""}`,
      }}
    />
  );
}
