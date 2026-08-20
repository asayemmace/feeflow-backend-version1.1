-- CreateTable
CREATE TABLE IF NOT EXISTS "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "checkoutRequestId" TEXT,
    "merchantRequestId" TEXT,
    "mpesaRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultDesc" TEXT,
    "resultCode" INTEGER,
    "callbackReceivedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "planExpiry" TIMESTAMP(3),
    "monthsGranted" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPayment_checkoutRequestId_key" ON "SubscriptionPayment"("checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPayment_mpesaRef_key" ON "SubscriptionPayment"("mpesaRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionPayment_userId_idx" ON "SubscriptionPayment"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionPayment_checkoutRequestId_idx" ON "SubscriptionPayment"("checkoutRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionPayment_createdAt_idx" ON "SubscriptionPayment"("createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'SubscriptionPayment_userId_fkey'
    ) THEN
        ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
