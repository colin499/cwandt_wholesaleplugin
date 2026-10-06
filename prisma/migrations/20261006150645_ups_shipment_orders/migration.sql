-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UpsShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sheetId" TEXT,
    "shopifyDraftOrderId" TEXT,
    "shopifyOrderId" TEXT,
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
INSERT INTO "new_UpsShipment" ("billedAccount", "billingType", "createdAt", "environment", "id", "orderName", "packagesJson", "serviceCode", "sheetId", "shipmentId", "shopifyCustomerId", "shopifyDraftOrderId", "status", "updatedAt", "voidedAt") SELECT "billedAccount", "billingType", "createdAt", "environment", "id", "orderName", "packagesJson", "serviceCode", "sheetId", "shipmentId", "shopifyCustomerId", "shopifyDraftOrderId", "status", "updatedAt", "voidedAt" FROM "UpsShipment";
DROP TABLE "UpsShipment";
ALTER TABLE "new_UpsShipment" RENAME TO "UpsShipment";
CREATE INDEX "UpsShipment_sheetId_idx" ON "UpsShipment"("sheetId");
CREATE INDEX "UpsShipment_shopifyDraftOrderId_idx" ON "UpsShipment"("shopifyDraftOrderId");
CREATE INDEX "UpsShipment_shopifyOrderId_idx" ON "UpsShipment"("shopifyOrderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
