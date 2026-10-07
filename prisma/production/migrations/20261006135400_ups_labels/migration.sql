-- AlterTable
ALTER TABLE "WholesaleCustomer" ADD COLUMN     "billUpsAccount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "upsAccountCountry" TEXT,
ADD COLUMN     "upsAccountNumber" TEXT,
ADD COLUMN     "upsAccountPostalCode" TEXT;

-- CreateTable
CREATE TABLE "UpsShipment" (
    "id" TEXT NOT NULL,
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
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpsShipment_sheetId_idx" ON "UpsShipment"("sheetId");

-- CreateIndex
CREATE INDEX "UpsShipment_shopifyDraftOrderId_idx" ON "UpsShipment"("shopifyDraftOrderId");

-- CreateIndex
CREATE INDEX "UpsShipment_shopifyOrderId_idx" ON "UpsShipment"("shopifyOrderId");

