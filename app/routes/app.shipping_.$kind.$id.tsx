/**
 * Ship with UPS — for ANY Shopify order or draft order, including ones staff
 * created by hand in Shopify Admin (nothing here depends on the order sheet).
 *   /app/shipping/order/<orderId>      /app/shipping/draft/<draftOrderId>
 *
 * The label is billed to the UPS account on file for the order's customer,
 * who must be in the app's Customers list with "Bill this account" ticked.
 *
 * Page body and all logic are shared with the order-sheet Ship page — see
 * app/lib/ups-ship.server.ts and app/components/UpsShipPage.tsx.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { handleShipAction, loadShipPage, type ShipTarget } from "../lib/ups-ship.server";
import { UpsShipPage } from "../components/UpsShipPage";

function paramsTarget(params: { kind?: string; id?: string }): ShipTarget | null {
  if (!params.id || !/^\d+$/.test(params.id)) return null;
  if (params.kind === "order") return { kind: "ORDER", id: params.id };
  if (params.kind === "draft") return { kind: "DRAFT", id: params.id };
  return null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const target = paramsTarget(params);
  if (!target) {
    throw new Response("Not found", { status: 404 });
  }
  return json(await loadShipPage(admin, target));
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return handleShipAction(admin, await request.formData(), paramsTarget(params));
};

export default function OrderShipPage() {
  const data = useLoaderData<typeof loader>();
  return <UpsShipPage data={data} backAction={{ content: "UPS Shipping", url: "/app/shipping" }} />;
}
