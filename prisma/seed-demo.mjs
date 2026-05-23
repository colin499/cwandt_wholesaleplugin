// Demo seed data for CW&T Wholesale App — populates the dev DB so the admin
// looks like a real, active wholesale business. Idempotent: safe to re-run.
// Run from project root:  node --env-file=.env prisma/seed-demo.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const now = new Date();

async function ensureSingleton(model, where, data) {
  const existing = await p[model].findFirst();
  if (existing) return existing;
  return p[model].create({ data });
}

async function ensureByField(model, field, value, data) {
  const existing = await p[model].findFirst({ where: { [field]: value } });
  if (existing) return existing;
  return p[model].create({ data });
}

async function main() {
  // --- App config ---
  await ensureSingleton("wholesaleSettings", {}, { maxDiscountPercent: 70 });
  await ensureSingleton("orderMinimumConfig", {}, {
    minimumOrderValue: 500, minimumOrderQuantity: null, active: true,
  });

  // --- Pricing rules ---
  const rules = [
    { name: "Standard Wholesale Discount", type: "GLOBAL_DISCOUNT", discountPercent: 40, active: true, sortOrder: 0 },
    { name: "Bulk Tier — 25+ units", type: "VOLUME_TIER", discountPercent: 5, minimumQuantity: 25, active: true, sortOrder: 1 },
    { name: "Bulk Tier — 50+ units", type: "VOLUME_TIER", discountPercent: 10, minimumQuantity: 50, active: true, sortOrder: 2 },
  ];
  for (const r of rules) await ensureByField("pricingRule", "name", r.name, r);

  // --- Pending applications (live-approve these in the demo) ---
  const apps = [
    { email: "maria@acmerestaurantsupply.com", firstName: "Maria", lastName: "Lopez", company: "Acme Restaurant Supply", website: "https://acmerestaurantsupply.com", phone: "718-555-0142", taxId: "12-3456789", resaleNumber: "NY-884213", estimatedMonthlyVolume: "$5,000–$10,000", message: "We run six restaurants in Brooklyn and want to stock your products wholesale.", status: "PENDING" },
    { email: "james@brooklyngoods.co", firstName: "James", lastName: "Chen", company: "Brooklyn Goods Co.", website: "https://brooklyngoods.co", phone: "347-555-0199", estimatedMonthlyVolume: "$2,000–$5,000", message: "Interested in carrying your line across our two retail shops.", status: "PENDING" },
    { email: "sarah@pacificoutfitters.com", firstName: "Sarah", lastName: "Kim", company: "Pacific Coast Outfitters", website: "https://pacificoutfitters.com", phone: "503-555-0123", estimatedMonthlyVolume: "$10,000+", message: "West-coast distributor looking to add your products to our catalog.", status: "PENDING" },
  ];
  for (const a of apps) await ensureByField("wholesaleApplication", "email", a.email, a);

  // --- Approved wholesale customers + distributors (display rows for a populated list).
  //     These use placeholder Shopify IDs — fine to display; do NOT edit them live in the
  //     demo (the Shopify GraphQL call would no-op). Use the Approve/Create flows for live actions.
  const customers = [
    { shopifyCustomerId: "9100000000001", email: "orders@hudsonvalleymercantile.com", firstName: "Dana", lastName: "Whitfield", company: "Hudson Valley Mercantile", status: "APPROVED", customerType: "WHOLESALE", discountPercent: 40, paymentTerms: "NET_30", approvedAt: now },
    { shopifyCustomerId: "9100000000002", email: "buyer@thecornershop.com", firstName: "Leah", lastName: "Park", company: "The Corner Shop", status: "APPROVED", customerType: "WHOLESALE", discountPercent: 40, paymentTerms: "CREDIT_CARD", approvedAt: now },
    { shopifyCustomerId: "9100000000003", email: "purchasing@makercollective.com", firstName: "Tomás", lastName: "Rivera", company: "Maker Collective", status: "APPROVED", customerType: "WHOLESALE", discountPercent: 40, paymentTerms: "NET_60", approvedAt: now },
    { shopifyCustomerId: "9200000000001", email: "wholesale@northstardistribution.com", firstName: "Erin", lastName: "Gallagher", company: "Northstar Distribution", status: "APPROVED", customerType: "DISTRIBUTOR", discountPercent: 50, paymentTerms: "NET_30", approvedAt: now },
    { shopifyCustomerId: "9200000000002", email: "ap@westcoastsupplyco.com", firstName: "Marcus", lastName: "Bell", company: "West Coast Supply Co.", status: "APPROVED", customerType: "DISTRIBUTOR", discountPercent: 50, paymentTerms: "NET_60", approvedAt: now },
  ];
  for (const c of customers) {
    await p.wholesaleCustomer.upsert({
      where: { shopifyCustomerId: c.shopifyCustomerId },
      update: {},
      create: c,
    });
  }

  // --- One open backorder so the dashboard shows a non-zero count (tied to a real customer) ---
  const anchor = await p.wholesaleCustomer.findFirst({ orderBy: { createdAt: "asc" } });
  const existingBackorder = await p.wholesaleOrder.findFirst({ where: { isBackorder: true } });
  if (anchor && !existingBackorder) {
    await p.wholesaleOrder.create({
      data: {
        shopifyCustomerId: anchor.shopifyCustomerId,
        orderName: "#WB-1001",
        paymentTerms: "NET_30",
        totalAmount: 642.0,
        currency: "USD",
        discountPercent: 40,
        isBackorder: true,
        backorderNote: "2 units on backorder — awaiting restock",
        orderTags: '["wholesale","backorder"]',
        status: "PENDING",
      },
    });
  }

  // --- Report ---
  const counts = {};
  for (const m of ["wholesaleCustomer", "wholesaleApplication", "pricingRule", "orderMinimumConfig", "wholesaleSettings", "wholesaleOrder"]) {
    counts[m] = await p[m].count();
  }
  console.log("Seed complete. Row counts:", counts);
}

main()
  .catch((e) => { console.error("Seed failed:", e); process.exitCode = 1; })
  .finally(() => p.$disconnect());
