-- CreateTable
CREATE TABLE "WholesaleSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "maxDiscountPercent" REAL NOT NULL DEFAULT 70,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
