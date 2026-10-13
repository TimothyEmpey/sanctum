-- Sanctum working book. Alpaca equity is stored beside it and is not used for sizing.
ALTER TABLE "Account" ADD COLUMN "fonzoPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "brokerEquityCents" INTEGER;
ALTER TABLE "Account" ADD COLUMN "brokerCashCents" INTEGER;
ALTER TABLE "Account" ADD COLUMN "bookResetAt" TIMESTAMP(3);

ALTER TABLE "StrategySession" ADD COLUMN "symbol" TEXT NOT NULL DEFAULT 'SPY';
DROP INDEX "StrategySession_accountId_sessionDate_key";
CREATE UNIQUE INDEX "StrategySession_accountId_sessionDate_symbol_key" ON "StrategySession"("accountId", "sessionDate", "symbol");

ALTER TABLE "Trade" ALTER COLUMN "quantity" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "Order" ALTER COLUMN "quantity" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "StrategySession" ALTER COLUMN "lastTradeShares" SET DATA TYPE DOUBLE PRECISION;

UPDATE "Account"
SET
  "brokerEquityCents" = COALESCE("brokerEquityCents", "equityCents"),
  "brokerCashCents" = COALESCE("brokerCashCents", "cashCents"),
  "equityCents" = 100000,
  "cashCents" = 100000,
  "peakEquityCents" = 100000,
  "dayStartEquityCents" = 100000,
  "weekStartEquityCents" = 100000,
  "bookResetAt" = CURRENT_TIMESTAMP
WHERE "bookResetAt" IS NULL;

INSERT INTO "EquitySnapshot" ("id", "accountId", "equityCents", "cashCents", "capturedAt")
SELECT 'sleeve-1000-' || "id", "id", 100000, 100000, CURRENT_TIMESTAMP
FROM "Account" a
WHERE NOT EXISTS (
  SELECT 1 FROM "EquitySnapshot" s WHERE s."id" = 'sleeve-1000-' || a."id"
);
