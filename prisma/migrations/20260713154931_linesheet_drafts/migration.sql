-- CreateTable
CREATE TABLE "LinesheetDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lines" TEXT NOT NULL DEFAULT '[]',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "LinesheetDraft_shopifyCustomerId_status_idx" ON "LinesheetDraft"("shopifyCustomerId", "status");
