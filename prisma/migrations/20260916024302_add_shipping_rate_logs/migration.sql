-- CreateTable
CREATE TABLE "ShippingRateLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT,
    "requestId" TEXT,
    "checkoutToken" TEXT,
    "currency" TEXT,
    "totalWeightGrams" INTEGER,
    "totalWeightKg" REAL,
    "itemCount" INTEGER,
    "destinationCountry" TEXT,
    "destinationState" TEXT,
    "destinationCity" TEXT,
    "destinationPostcode" TEXT,
    "requestJson" TEXT,
    "itemsJson" TEXT,
    "provider" TEXT,
    "providerRequestJson" TEXT,
    "providerResponseJson" TEXT,
    "providerHttpStatus" INTEGER,
    "totalQuoteCount" INTEGER,
    "quoteBreakdownJson" TEXT,
    "returnedRatesJson" TEXT,
    "returnedRateCount" INTEGER,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShippingRateLog_requestId_key" ON "ShippingRateLog"("requestId");

-- CreateIndex
CREATE INDEX "ShippingRateLog_shop_idx" ON "ShippingRateLog"("shop");

-- CreateIndex
CREATE INDEX "ShippingRateLog_createdAt_idx" ON "ShippingRateLog"("createdAt");

-- CreateIndex
CREATE INDEX "ShippingRateLog_status_idx" ON "ShippingRateLog"("status");

-- CreateIndex
CREATE INDEX "ShippingRateLog_provider_idx" ON "ShippingRateLog"("provider");

-- CreateIndex
CREATE INDEX "ShippingRateLog_requestId_idx" ON "ShippingRateLog"("requestId");
