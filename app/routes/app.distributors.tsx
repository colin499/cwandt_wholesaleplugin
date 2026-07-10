import { redirect } from "@remix-run/node";

// The Distributors page was merged into /app/customers (distributors are a
// customer type there). Kept as a redirect so old links and bookmarks work.
export const loader = () => redirect("/app/customers");
