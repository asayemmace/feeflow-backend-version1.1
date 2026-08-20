ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "paymentTermId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Payment"
SET "receivedAt" = COALESCE("createdAt", "receivedAt", CURRENT_TIMESTAMP)
WHERE "createdAt" IS NOT NULL;

UPDATE "Payment" p
SET "paymentTermId" = t."id"
FROM "Term" t
WHERE p."paymentTermId" IS NULL
  AND t."userId" = p."userId"
  AND p."createdAt" >= t."startDate"
  AND p."createdAt" <= t."endDate";

CREATE INDEX IF NOT EXISTS "Payment_userId_paymentTermId_idx" ON "Payment"("userId", "paymentTermId");
CREATE INDEX IF NOT EXISTS "Payment_studentId_paymentTermId_idx" ON "Payment"("studentId", "paymentTermId");
