import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Preserve query params (shop, hmac, id_token, etc.) for auth middleware
  return redirect(`/app${url.search}`);
};
