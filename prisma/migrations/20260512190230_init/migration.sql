-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "WholesaleCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "discountPercent" REAL NOT NULL DEFAULT 40,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WholesaleApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "shopifyCustomerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesaleApplication_shopifyCustomerId_fkey" FOREIGN KEY ("shopifyCustomerId") REFERENCES "WholesaleCustomer" ("shopifyCustomerId") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GLOBAL_DISCOUNT',
    "discountPercent" REAL NOT NULL,
    "minimumQuantity" INTEGER,
    "minimumCartValue" REAL,
    "shopifyProductId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderMinimumConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "minimumOrderValue" REAL NOT NULL DEFAULT 500,
    "minimumOrderQuantity" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WholesaleOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderId" TEXT,
    "shopifyDraftOrderId" TEXT,
    "orderName" TEXT,
    "shopifyCustomerId" TEXT NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "totalAmount" REAL NOT NULL,
    "discountPercent" REAL NOT NULL,
    "isBackorder" BOOLEAN NOT NULL DEFAULT false,
    "backorderNote" TEXT,
    "orderTags" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "shopifyCreatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesaleOrder_shopifyCustomerId_fkey" FOREIGN KEY ("shopifyCustomerId") REFERENCES "WholesaleCustomer" ("shopifyCustomerId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CmsSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "syncType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "shopifyId" TEXT,
    "cmsRecordId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleCustomer_shopifyCustomerId_key" ON "WholesaleCustomer"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleApplication_shopifyCustomerId_key" ON "WholesaleApplication"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleOrder_shopifyOrderId_key" ON "WholesaleOrder"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleOrder_shopifyDraftOrderId_key" ON "WholesaleOrder"("shopifyDraftOrderId");
