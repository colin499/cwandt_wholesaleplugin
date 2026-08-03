-- AlterTable
ALTER TABLE "LinesheetDraft" ADD COLUMN "editBaseUpdatedAt" DATETIME;
ALTER TABLE "LinesheetDraft" ADD COLUMN "shopifyBackorderDraftOrderId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WholesaleOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderId" TEXT,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "shopifyCustomerId" TEXT NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "totalAmount" REAL NOT NULL,
    "currency" TEXT,
    "discountPercent" REAL NOT NULL,
    "isBackorder" BOOLEAN NOT NULL DEFAULT false,
    "backorderNote" TEXT,
    "orderTags" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "linesJson" TEXT NOT NULL DEFAULT '[]',
    "shopifyUpdatedAt" DATETIME,
    "shopifyCreatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesaleOrder_shopifyCustomerId_fkey" FOREIGN KEY ("shopifyCustomerId") REFERENCES "WholesaleCustomer" ("shopifyCustomerId") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_WholesaleOrder" ("backorderNote", "createdAt", "currency", "discountPercent", "id", "isBackorder", "orderName", "orderTags", "paymentTerms", "shopifyCreatedAt", "shopifyCustomerId", "shopifyDraftOrderId", "shopifyOrderId", "status", "totalAmount", "updatedAt") SELECT "backorderNote", "createdAt", "currency", "discountPercent", "id", "isBackorder", "orderName", "orderTags", "paymentTerms", "shopifyCreatedAt", "shopifyCustomerId", "shopifyDraftOrderId", "shopifyOrderId", "status", "totalAmount", "updatedAt" FROM "WholesaleOrder";
DROP TABLE "WholesaleOrder";
ALTER TABLE "new_WholesaleOrder" RENAME TO "WholesaleOrder";
CREATE UNIQUE INDEX "WholesaleOrder_shopifyOrderId_key" ON "WholesaleOrder"("shopifyOrderId");
CREATE UNIQUE INDEX "WholesaleOrder_shopifyDraftOrderId_key" ON "WholesaleOrder"("shopifyDraftOrderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
