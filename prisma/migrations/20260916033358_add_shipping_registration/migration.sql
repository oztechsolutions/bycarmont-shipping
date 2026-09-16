/*
  Warnings:

  - The primary key for the `ShippingRegistration` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The required column `id` was added to the `ShippingRegistration` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `updatedAt` to the `ShippingRegistration` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShippingRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "ccsRequired" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShippingRegistration" ("ccsRequired", "message", "shop") SELECT "ccsRequired", "message", "shop" FROM "ShippingRegistration";
DROP TABLE "ShippingRegistration";
ALTER TABLE "new_ShippingRegistration" RENAME TO "ShippingRegistration";
CREATE UNIQUE INDEX "ShippingRegistration_shop_key" ON "ShippingRegistration"("shop");
CREATE INDEX "ShippingRegistration_shop_idx" ON "ShippingRegistration"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
