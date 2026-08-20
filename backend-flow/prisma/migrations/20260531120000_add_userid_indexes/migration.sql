CREATE INDEX IF NOT EXISTS "Student_userId_idx" ON "Student"("userId");

CREATE INDEX IF NOT EXISTS "Payment_userId_idx" ON "Payment"("userId");
CREATE INDEX IF NOT EXISTS "Payment_studentId_idx" ON "Payment"("studentId");

CREATE INDEX IF NOT EXISTS "Invoice_userId_idx" ON "Invoice"("userId");

CREATE INDEX IF NOT EXISTS "MpesaTransaction_userId_idx" ON "MpesaTransaction"("userId");

CREATE INDEX IF NOT EXISTS "StudentCharge_studentId_idx" ON "StudentCharge"("studentId");
CREATE INDEX IF NOT EXISTS "StudentCharge_studentId_voidedAt_idx" ON "StudentCharge"("studentId", "voidedAt");
CREATE INDEX IF NOT EXISTS "StudentCharge_userId_voidedAt_idx" ON "StudentCharge"("userId", "voidedAt");
