ALTER TABLE "UnmatchedPayment"
  ADD COLUMN "senderName" TEXT,
  ADD COLUMN "billRefNumber" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "method" TEXT;

ALTER TABLE "MpesaTransaction"
  ADD COLUMN "payerName" TEXT;
