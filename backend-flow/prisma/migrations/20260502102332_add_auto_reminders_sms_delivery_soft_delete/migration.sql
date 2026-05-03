-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "smsMessageId" TEXT,
ADD COLUMN     "smsStatus" TEXT DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "smsMessageId" TEXT,
ADD COLUMN     "smsStatus" TEXT DEFAULT 'pending';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "autoReminders" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Invoice_smsMessageId_idx" ON "Invoice"("smsMessageId");

-- CreateIndex
CREATE INDEX "Receipt_smsMessageId_idx" ON "Receipt"("smsMessageId");
