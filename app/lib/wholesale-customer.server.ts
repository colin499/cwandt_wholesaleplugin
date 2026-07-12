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
import { resolveDiscountPercent } from "./enrollment.server";

export type WholesaleSession = {
  shopifyCustomerId: string;
  discountPercent: number;       // resolved: customer override ?? pricing profile ?? 50
  paymentTerms: string;
  company: string | null;
  status: string;
  customerType: string;          // "WHOLESALE" | "DISTRIBUTOR" | "B2B"
  minimumOrderValue: number | null; // resolved override (customer ?? profile); null = use global
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
      pricingProfile: {
        select: { discountPercent: true, minimumOrderValue: true },
      },
    },
  });

  if (!customer || customer.status !== "APPROVED") return null;

  return {
    shopifyCustomerId: customer.shopifyCustomerId,
    discountPercent: resolveDiscountPercent(customer),
    paymentTerms: customer.paymentTerms,
    company: customer.company,
    status: customer.status,
    customerType: customer.customerType,
    minimumOrderValue:
      customer.minimumOrderValue ?? customer.pricingProfile?.minimumOrderValue ?? null,
  };
}

// NOTE (2026-07-12, Phase A): the percentage-discount machinery that lived
// here — getActiveGlobalDiscount, applyVolumeTier, calculateWholesalePrice,
// getMaxDiscountPercent — was removed. Storefront pricing is CMS-driven per
// variant (see cms-client.server.ts resolveVariantWholesale); variants not in
// the CMS are simply not wholesale. The PricingRule table still exists but is
// read by nothing; drop it in a future cleanup migration.

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
      select: {
        minimumOrderValue: true,
        status: true,
        pricingProfile: { select: { minimumOrderValue: true } },
      },
    });
    if (customer?.status === "APPROVED") {
      const override =
        customer.minimumOrderValue ?? customer.pricingProfile?.minimumOrderValue ?? null;
      if (override !== null) {
        return { minimumOrderValue: override, minimumOrderQuantity: null };
      }
    }
  }
  const config = await getOrderMinimumConfig();
  return {
    minimumOrderValue: config?.minimumOrderValue ?? 500,
    minimumOrderQuantity: config?.minimumOrderQuantity ?? null,
  };
}
