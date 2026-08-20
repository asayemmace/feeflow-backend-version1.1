ALTER TABLE "UnmatchedPayment"
  ADD COLUMN "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
  ADD COLUMN "matchConfidence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "matchReason" TEXT,
  ADD COLUMN "matchedStudentId" TEXT,
  ADD COLUMN "suggestedStudentId" TEXT,
  ADD COLUMN "suggestedReason" TEXT,
  ADD COLUMN "transactionDate" TIMESTAMP(3);

CREATE INDEX "UnmatchedPayment_userId_matchStatus_idx" ON "UnmatchedPayment"("userId", "matchStatus");
