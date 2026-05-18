-- CreateTable
CREATE TABLE "CmsVariantCache" (
    "shopifyVariantId" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL DEFAULT '',
    "wholesalePriceCents" INTEGER NOT NULL,
    "distributorPriceCents" INTEGER NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "cmsStatus" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CmsSyncState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastSyncedAt" DATETIME,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);
