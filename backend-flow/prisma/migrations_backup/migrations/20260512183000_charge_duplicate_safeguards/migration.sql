ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

ALTER TABLE "StudentCharge"
  ADD COLUMN IF NOT EXISTS "splitCharge" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_idempotencyKey_key"
  ON "Invoice"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "StudentCharge_idempotencyKey_key"
  ON "StudentCharge"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "StudentCharge_active_equivalent_unique_idx"
  ON "StudentCharge"(
    "studentId",
    (COALESCE("termId", '')),
    "type",
    "amount",
    "description"
  )
  WHERE "voidedAt" IS NULL AND "splitCharge" = false;
