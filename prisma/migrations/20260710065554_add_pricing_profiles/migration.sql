-- CreateTable
CREATE TABLE "PricingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "discountPercent" REAL NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "minimumOrderValue" REAL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WholesaleCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "customerType" TEXT NOT NULL DEFAULT 'WHOLESALE',
    "pricingProfileId" TEXT,
    "discountPercent" REAL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "minimumOrderValue" REAL,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesaleCustomer_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WholesaleCustomer" ("approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "shopifyCustomerId", "status", "updatedAt") SELECT "approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "shopifyCustomerId", "status", "updatedAt" FROM "WholesaleCustomer";
DROP TABLE "WholesaleCustomer";
ALTER TABLE "new_WholesaleCustomer" RENAME TO "WholesaleCustomer";
CREATE UNIQUE INDEX "WholesaleCustomer_shopifyCustomerId_key" ON "WholesaleCustomer"("shopifyCustomerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_name_key" ON "PricingProfile"("name");

-- Seed the three pricing profiles with fixed ids (referenced from app code).
-- Distributor and B2B start at the wholesale rate (50%) pending the open
-- business decision (REMAINING.md item 2); change the row, not the code.
INSERT INTO "PricingProfile" ("id", "name", "discountPercent", "paymentTerms", "minimumOrderValue", "active", "createdAt", "updatedAt")
VALUES
  ('pp_wholesale',   'Wholesale',   50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pp_distributor', 'Distributor', 50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pp_b2b',         'B2B',         50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Backfill existing customers onto the profile matching their type.
UPDATE "WholesaleCustomer" SET "pricingProfileId" = 'pp_distributor' WHERE "customerType" = 'DISTRIBUTOR' AND "pricingProfileId" IS NULL;
UPDATE "WholesaleCustomer" SET "pricingProfileId" = 'pp_wholesale'  WHERE "customerType" = 'WHOLESALE'   AND "pricingProfileId" IS NULL;

-- Rows sitting at the old schema default (50) were never individually
-- negotiated — clear them so they track their profile's rate. Genuine
-- per-customer overrides (any other value) are preserved.
UPDATE "WholesaleCustomer" SET "discountPercent" = NULL
WHERE "discountPercent" = 50
  AND "pricingProfileId" IS NOT NULL
  AND "discountPercent" = (SELECT "discountPercent" FROM "PricingProfile" WHERE "id" = "pricingProfileId");
