-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LinesheetDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lines" TEXT NOT NULL DEFAULT '[]',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "poNumber" TEXT,
    "shipOwnLabel" BOOLEAN NOT NULL DEFAULT false,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LinesheetDraft" ("createdAt", "id", "lines", "orderName", "shopifyCustomerId", "shopifyDraftOrderId", "status", "subtotalCents", "updatedAt") SELECT "createdAt", "id", "lines", "orderName", "shopifyCustomerId", "shopifyDraftOrderId", "status", "subtotalCents", "updatedAt" FROM "LinesheetDraft";
DROP TABLE "LinesheetDraft";
ALTER TABLE "new_LinesheetDraft" RENAME TO "LinesheetDraft";
CREATE INDEX "LinesheetDraft_shopifyCustomerId_status_idx" ON "LinesheetDraft"("shopifyCustomerId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
