-- AlterTable
ALTER TABLE "WholesaleOrder" ADD COLUMN     "linesJson" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "shopifyUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LinesheetDraft" ADD COLUMN     "editBaseUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyBackorderDraftOrderId" TEXT;

