-- Strict ledger accounting: ledger tables, allocation table, and legacy backfill.

ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reversedBy" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "isReversal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "originalPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "overpaymentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "accountTotalCharges" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "totalPaidToDate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "totalDueNow" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "newChargesTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "previousOutstanding" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "BalanceLedger" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "paymentId" TEXT,
  "delta" DOUBLE PRECISION NOT NULL,
  "balanceBefore" DOUBLE PRECISION NOT NULL,
  "balanceAfter" DOUBLE PRECISION NOT NULL,
  "source" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BalanceLedger_studentId_createdAt_idx" ON "BalanceLedger"("studentId", "createdAt");
CREATE INDEX IF NOT EXISTS "BalanceLedger_userId_createdAt_idx" ON "BalanceLedger"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "StudentCharge" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "termId" TEXT,
  "invoiceId" TEXT,
  "type" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "voidedAt" TIMESTAMP(3),
  "voidedBy" TEXT,
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudentCharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StudentCharge_studentId_termId_idx" ON "StudentCharge"("studentId", "termId");
CREATE INDEX IF NOT EXISTS "StudentCharge_userId_termId_idx" ON "StudentCharge"("userId", "termId");
CREATE INDEX IF NOT EXISTS "StudentCharge_invoiceId_idx" ON "StudentCharge"("invoiceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "StudentCharge"
    WHERE "voidedAt" IS NULL
    GROUP BY "studentId", COALESCE("termId", ''), "type", COALESCE("invoiceId", ''), "amount", "description"
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "StudentCharge_exact_active_unique_idx"
      ON "StudentCharge"("studentId", (COALESCE("termId", '')), "type", (COALESCE("invoiceId", '')), "amount", "description")
      WHERE "voidedAt" IS NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CreditMemo" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "termId" TEXT,
  "sourcePaymentId" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "remainingAmount" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'available',
  "appliedToTermId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditMemo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CreditMemo_studentId_status_idx" ON "CreditMemo"("studentId", "status");
CREATE INDEX IF NOT EXISTS "CreditMemo_userId_idx" ON "CreditMemo"("userId");

CREATE TABLE IF NOT EXISTS "PaymentAllocation" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "studentChargeId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
CREATE INDEX IF NOT EXISTS "PaymentAllocation_studentChargeId_idx" ON "PaymentAllocation"("studentChargeId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAllocation_paymentId_fkey') THEN
    ALTER TABLE "PaymentAllocation"
      ADD CONSTRAINT "PaymentAllocation_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAllocation_studentChargeId_fkey') THEN
    ALTER TABLE "PaymentAllocation"
      ADD CONSTRAINT "PaymentAllocation_studentChargeId_fkey"
      FOREIGN KEY ("studentChargeId") REFERENCES "StudentCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill one opening tuition charge per student where legacy fee exists and no charges exist.
INSERT INTO "StudentCharge" ("id", "studentId", "userId", "termId", "invoiceId", "type", "description", "amount", "createdAt")
SELECT 'mig_charge_' || s."id", s."id", s."userId", s."termId", NULL, 'tuition', 'Opening tuition balance', s."fee", COALESCE(s."createdAt", CURRENT_TIMESTAMP)
FROM "Student" s
WHERE COALESCE(s."fee", 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "StudentCharge" sc
    WHERE sc."studentId" = s."id" AND sc."voidedAt" IS NULL
  )
ON CONFLICT ("id") DO NOTHING;

-- Backfill one opening payment per student where legacy paid exists and no valid payment exists.
INSERT INTO "Payment" ("id", "amount", "txnRef", "method", "termId", "studentId", "feeBreakdown", "userId", "createdAt", "deletedAt", "reversedAt", "isReversal", "overpaymentAmount", "version")
SELECT 'mig_payment_' || s."id", s."paid", NULL, 'migration_opening_balance', s."termId", s."id", '[]'::jsonb, s."userId", COALESCE(s."createdAt", CURRENT_TIMESTAMP), NULL, NULL, false, GREATEST(0, s."paid" - s."fee"), 1
FROM "Student" s
WHERE COALESCE(s."paid", 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM "Payment" p
    WHERE p."studentId" = s."id"
      AND p."deletedAt" IS NULL
      AND p."reversedAt" IS NULL
      AND p."isReversal" = false
  )
ON CONFLICT ("id") DO NOTHING;
