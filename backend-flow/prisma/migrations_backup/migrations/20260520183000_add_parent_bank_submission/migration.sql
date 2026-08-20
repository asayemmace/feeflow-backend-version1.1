CREATE TYPE "ParentBankPaymentStatus" AS ENUM (
  'UNDER_REVIEW',
  'CONFIRMED',
  'REJECTED',
  'DUPLICATE'
);

CREATE TABLE "ParentBankPaymentSubmission" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "studentId" TEXT,
  "parentName" TEXT,
  "parentPhone" TEXT,
  "transactionRef" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "paidAt" TIMESTAMP(3),
  "note" TEXT,
  "proofPath" TEXT,
  "status" "ParentBankPaymentStatus" NOT NULL DEFAULT 'UNDER_REVIEW',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "createdPaymentId" TEXT,
  "createdReceiptId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "ParentBankPaymentSubmission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ParentBankPaymentSubmission_userId_transactionRef_idx" ON "ParentBankPaymentSubmission"("userId", "transactionRef");
CREATE INDEX "ParentBankPaymentSubmission_userId_status_idx" ON "ParentBankPaymentSubmission"("userId", "status");
CREATE INDEX "ParentBankPaymentSubmission_invoiceId_idx" ON "ParentBankPaymentSubmission"("invoiceId");
CREATE INDEX "ParentBankPaymentSubmission_studentId_idx" ON "ParentBankPaymentSubmission"("studentId");

ALTER TABLE "ParentBankPaymentSubmission"
  ADD CONSTRAINT "ParentBankPaymentSubmission_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
