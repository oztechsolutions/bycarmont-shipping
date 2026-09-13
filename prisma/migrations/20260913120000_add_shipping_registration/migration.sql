-- CreateTable
CREATE TABLE "ShippingRegistration" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "ccsRequired" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT
);