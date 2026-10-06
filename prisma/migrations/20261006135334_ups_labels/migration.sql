-- CreateTable
CREATE TABLE "UpsShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sheetId" TEXT NOT NULL,
    "shopifyDraftOrderId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "orderName" TEXT,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "shipmentId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "billingType" TEXT NOT NULL,
    "billedAccount" TEXT NOT NULL,
    "packagesJson" TEXT NOT NULL DEFAULT '[]',
    "voidedAt" DATETIME,
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
    "exemptFromMoq" BOOLEAN NOT NULL DEFAULT false,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "upsAccountNumber" TEXT,
    "upsAccountPostalCode" TEXT,
    "upsAccountCountry" TEXT,
    "billUpsAccount" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesaleCustomer_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WholesaleCustomer" ("approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "exemptFromMoq", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "pricingProfileId", "shopifyCustomerId", "status", "taxExempt", "updatedAt") SELECT "approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "exemptFromMoq", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "pricingProfileId", "shopifyCustomerId", "status", "taxExempt", "updatedAt" FROM "WholesaleCustomer";
DROP TABLE "WholesaleCustomer";
ALTER TABLE "new_WholesaleCustomer" RENAME TO "WholesaleCustomer";
CREATE UNIQUE INDEX "WholesaleCustomer_shopifyCustomerId_key" ON "WholesaleCustomer"("shopifyCustomerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UpsShipment_sheetId_idx" ON "UpsShipment"("sheetId");

-- CreateIndex
CREATE INDEX "UpsShipment_shopifyDraftOrderId_idx" ON "UpsShipment"("shopifyDraftOrderId");
