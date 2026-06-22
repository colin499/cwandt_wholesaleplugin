/**
 * Wholesale customer session utilities.
 *
 * These are the canonical server-side checks for whether a request comes from
 * an approved wholesale customer. Used by the App Proxy route and admin routes.
 *
 * The "middleware" concept here is a set of pure functions — not HTTP middleware —
 * because Remix uses loader/action functions rather than middleware chains.
 */

import { db } from "../db.server";

export type WholesaleSession = {
  shopifyCustomerId: string;
  discountPercent: number;
  paymentTerms: string;
  company: string | null;
  status: string;
  customerType: string;          // "WHOLESALE" | "DISTRIBUTOR"
  minimumOrderValue: number | null; // per-customer override; null = use global
};

/**
 * Given a Shopify customer ID (from the App Proxy's signed `logged_in_customer_id`
 * query param), returns the customer's wholesale session or null.
 *
 * Only returns data for APPROVED customers. PENDING / REJECTED / SUSPENDED
 * all return null — they see retail prices.
 */
export async function getWholesaleSession(
  shopifyCustomerId: string | null | undefined
): Promise<WholesaleSession | null> {
  if (!shopifyCustomerId) return null;

  const customer = await db.wholesaleCustomer.findUnique({
    where: { shopifyCustomerId },
    select: {
      shopifyCustomerId: true,
      discountPercent: true,
      paymentTerms: true,
      company: true,
      status: true,
      customerType: true,
      minimumOrderValue: true,
    },
  });

  if (!customer || customer.status !== "APPROVED") return null;

  return customer;
}

/**
 * Returns the active global discount percentage.
 * Falls back to the customer's own discountPercent if no global rule exists.
 * Volume-tier rules are checked separately via applyVolumeTier().
 */
export async function getActiveGlobalDiscount(
  fallbackPercent = 50
): Promise<number> {
  const rule = await db.pricingRule.findFirst({
    where: { type: "GLOBAL_DISCOUNT", active: true },
    orderBy: { sortOrder: "asc" },
  });
  return rule?.discountPercent ?? fallbackPercent;
}

/**
 * Returns the configured maximum combined discount percentage.
 * Defaults to 70 if no WholesaleSettings row exists yet.
 */
export async function getMaxDiscountPercent(): Promise<number> {
  const settings = await db.wholesaleSettings.findFirst();
  return settings?.maxDiscountPercent ?? 70;
}

/**
 * Returns the effective discount for a given base discount and cart quantity,
 * stacking the best matching volume tier on top.
 *
 * The result is capped at WholesaleSettings.maxDiscountPercent (default 70%).
 * This prevents misconfigured rules (e.g. 60% global + 50% tier) from
 * producing a negative price.
 */
export async function applyVolumeTier(
  baseDiscount: number,
  cartQuantity: number
): Promise<number> {
  const [tiers, settings] = await Promise.all([
    db.pricingRule.findMany({
      where: { type: "VOLUME_TIER", active: true },
      orderBy: { minimumQuantity: "desc" }, // highest threshold first
    }),
    db.wholesaleSettings.findFirst(),
  ]);

  const maxDiscount = settings?.maxDiscountPercent ?? 70;

  for (const tier of tiers) {
    if (tier.minimumQuantity && cartQuantity >= tier.minimumQuantity) {
      return Math.min(baseDiscount + tier.discountPercent, maxDiscount);
    }
  }

  return Math.min(baseDiscount, maxDiscount);
}

/**
 * Calculates the wholesale price in cents given a retail price in cents and
 * a discount percentage. Rounds to nearest cent.
 */
export function calculateWholesalePrice(
  retailPriceCents: number,
  discountPercent: number
): number {
  return Math.round(retailPriceCents * (1 - discountPercent / 100));
}

/**
 * Returns the active order minimum config. Safe to call on every request —
 * result should be cached at the route level if called frequently.
 */
export async function getOrderMinimumConfig() {
  return db.orderMinimumConfig.findFirst({ where: { active: true } });
}

/**
 * Returns the effective minimum order value for a customer in dollars.
 * Uses the customer's per-account override if set; otherwise falls back to
 * the global OrderMinimumConfig. Returns { minimumOrderValue, minimumOrderQuantity }.
 */
export async function getEffectiveOrderMinimum(
  shopifyCustomerId: string | null | undefined
): Promise<{ minimumOrderValue: number; minimumOrderQuantity: number | null }> {
  if (shopifyCustomerId) {
    const customer = await db.wholesaleCustomer.findUnique({
      where: { shopifyCustomerId },
      select: { minimumOrderValue: true, status: true },
    });
    if (customer?.status === "APPROVED" && customer.minimumOrderValue !== null) {
      return { minimumOrderValue: customer.minimumOrderValue, minimumOrderQuantity: null };
    }
  }
  const config = await getOrderMinimumConfig();
  return {
    minimumOrderValue: config?.minimumOrderValue ?? 500,
    minimumOrderQuantity: config?.minimumOrderQuantity ?? null,
  };
}
