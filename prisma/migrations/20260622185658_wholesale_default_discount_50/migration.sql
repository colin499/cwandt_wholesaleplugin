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
    "discountPercent" REAL NOT NULL DEFAULT 50,
    "paymentTerms" TEXT NOT NULL DEFAULT 'CREDIT_CARD',
    "minimumOrderValue" REAL,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_WholesaleCustomer" ("approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "shopifyCustomerId", "status", "updatedAt") SELECT "approvedAt", "approvedBy", "company", "createdAt", "customerType", "discountPercent", "email", "firstName", "id", "lastName", "minimumOrderValue", "notes", "paymentTerms", "phone", "shopifyCustomerId", "status", "updatedAt" FROM "WholesaleCustomer";
DROP TABLE "WholesaleCustomer";
ALTER TABLE "new_WholesaleCustomer" RENAME TO "WholesaleCustomer";
CREATE UNIQUE INDEX "WholesaleCustomer_shopifyCustomerId_key" ON "WholesaleCustomer"("shopifyCustomerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
