-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "minimumOrderValue" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleCustomer" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "customerType" TEXT NOT NULL DEFAULT 'WHOLESALE',
    "pricingProfileId" TEXT,
    "discountPercent" DOUBLE PRECISION,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "minimumOrderValue" DOUBLE PRECISION,
    "exemptFromMoq" BOOLEAN NOT NULL DEFAULT false,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleApplication" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "website" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "resaleNumber" TEXT,
    "estimatedMonthlyVolume" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "shopifyCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GLOBAL_DISCOUNT',
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "minimumQuantity" INTEGER,
    "minimumCartValue" DOUBLE PRECISION,
    "shopifyProductId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMinimumConfig" (
    "id" TEXT NOT NULL,
    "minimumOrderValue" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "minimumOrderQuantity" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMinimumConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleOrder" (
    "id" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "shopifyCustomerId" TEXT NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT,
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "isBackorder" BOOLEAN NOT NULL DEFAULT false,
    "backorderNote" TEXT,
    "orderTags" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "shopifyCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleSettings" (
    "id" TEXT NOT NULL,
    "maxDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinesheetDraft" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lines" TEXT NOT NULL DEFAULT '[]',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "poNumber" TEXT,
    "shipOwnLabel" BOOLEAN NOT NULL DEFAULT false,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinesheetDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmsVariantCache" (
    "shopifyVariantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL DEFAULT '',
    "wholesalePriceCents" INTEGER NOT NULL,
    "distributorPriceCents" INTEGER NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "caseSize" INTEGER,
    "cmsStatus" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsVariantCache_pkey" PRIMARY KEY ("shopifyVariantId")
);

-- CreateTable
CREATE TABLE "CmsSyncState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastSyncedAt" TIMESTAMP(3),
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmsSyncLog" (
    "id" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "shopifyId" TEXT,
    "cmsRecordId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmsSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_name_key" ON "PricingProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleCustomer_shopifyCustomerId_key" ON "WholesaleCustomer"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleApplication_shopifyCustomerId_key" ON "WholesaleApplication"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleOrder_shopifyOrderId_key" ON "WholesaleOrder"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleOrder_shopifyDraftOrderId_key" ON "WholesaleOrder"("shopifyDraftOrderId");

-- CreateIndex
CREATE INDEX "LinesheetDraft_shopifyCustomerId_status_idx" ON "LinesheetDraft"("shopifyCustomerId", "status");

-- AddForeignKey
ALTER TABLE "WholesaleCustomer" ADD CONSTRAINT "WholesaleCustomer_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WholesaleApplication" ADD CONSTRAINT "WholesaleApplication_shopifyCustomerId_fkey" FOREIGN KEY ("shopifyCustomerId") REFERENCES "WholesaleCustomer"("shopifyCustomerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WholesaleOrder" ADD CONSTRAINT "WholesaleOrder_shopifyCustomerId_fkey" FOREIGN KEY ("shopifyCustomerId") REFERENCES "WholesaleCustomer"("shopifyCustomerId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Seed the fixed pricing profiles (mirrors 20260710065554_add_pricing_profiles
-- from the SQLite dev migrations; app code references these ids directly).
INSERT INTO "PricingProfile" ("id", "name", "discountPercent", "paymentTerms", "minimumOrderValue", "active", "createdAt", "updatedAt")
VALUES
  ('pp_wholesale',   'Wholesale',   50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pp_distributor', 'Distributor', 50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pp_b2b',         'B2B',         50, 'CREDIT_CARD', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
