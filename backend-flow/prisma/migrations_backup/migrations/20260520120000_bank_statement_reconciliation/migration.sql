CREATE TYPE "BankPaymentStatus" AS ENUM (
  'FULL',
  'PARTIAL',
  'OVERPAYMENT',
  'UNMATCHED',
  'DUPLICATE',
  'NEEDS_REVIEW'
);

CREATE TABLE "BankStatementUpload" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL,
  "uploadedBy" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  CONSTRAINT "BankStatementUpload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankTransaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "transactionRef" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "payerName" TEXT,
  "narration" TEXT,
  "rawRowJson" JSONB NOT NULL DEFAULT '{}',
  "matchedStudentId" TEXT,
  "suggestedStudentId" TEXT,
  "suggestedReason" TEXT,
  "matchConfidence" INTEGER NOT NULL DEFAULT 0,
  "matchReason" TEXT,
  "paymentStatus" "BankPaymentStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "requiredBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdReceiptId" TEXT,
  "createdPaymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BankStatementUpload_userId_fileHash_idx" ON "BankStatementUpload"("userId", "fileHash");
CREATE INDEX "BankStatementUpload_userId_uploadedAt_idx" ON "BankStatementUpload"("userId", "uploadedAt");
CREATE INDEX "BankTransaction_userId_transactionRef_idx" ON "BankTransaction"("userId", "transactionRef");
CREATE INDEX "BankTransaction_userId_uploadId_idx" ON "BankTransaction"("userId", "uploadId");
CREATE INDEX "BankTransaction_matchedStudentId_idx" ON "BankTransaction"("matchedStudentId");
CREATE INDEX "BankTransaction_paymentStatus_idx" ON "BankTransaction"("paymentStatus");

CREATE UNIQUE INDEX "BankTransaction_userId_transactionRef_unique_not_null"
  ON "BankTransaction"("userId", "transactionRef")
  WHERE "transactionRef" IS NOT NULL AND btrim("transactionRef") <> '';

ALTER TABLE "BankStatementUpload"
  ADD CONSTRAINT "BankStatementUpload_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_uploadId_fkey"
  FOREIGN KEY ("uploadId") REFERENCES "BankStatementUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
