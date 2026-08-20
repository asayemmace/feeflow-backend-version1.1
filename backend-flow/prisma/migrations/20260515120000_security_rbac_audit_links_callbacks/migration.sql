-- FeeFlow security hardening migration notes:
-- 1. Replaces the legacy PasswordReset table with database-backed PasswordResetToken rows.
-- 2. Expands AuditLog into a structured admin/security log. Existing audit rows are migrated.
-- 3. Adds StaffUser for Max-plan RBAC staff accounts.
-- 4. Adds MpesaCallbackLog for sanitized raw callback persistence.
-- 5. Existing Invoice.token and Receipt.token values remain for legacy links; new links are signed JWTs.

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- Do not migrate legacy plaintext reset codes into codeHash. Existing reset
-- requests are invalidated; users can request a new hashed code after deploy.
DROP TABLE IF EXISTS "PasswordReset";

CREATE TABLE "StaffUser" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT NOT NULL,
  "jobTitle" TEXT,
  "passwordHash" TEXT,
  "permissions" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'invited',
  "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inviteTokenHash" TEXT,
  "inviteExpiresAt" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog_new" (
  "id" TEXT NOT NULL,
  "schoolOwnerId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorStaffId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "metadataJson" JSONB NOT NULL DEFAULT '{}',
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_new_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AuditLog_new" ("id", "schoolOwnerId", "actorUserId", "action", "metadataJson", "createdAt")
SELECT "id", "userId", "userId", "action", COALESCE("details", '{}'), "createdAt"
FROM "AuditLog";

DROP TABLE "AuditLog";
ALTER TABLE "AuditLog_new" RENAME TO "AuditLog";

CREATE TABLE "MpesaCallbackLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "checkoutRequestId" TEXT,
  "merchantRequestId" TEXT,
  "resultCode" INTEGER,
  "resultDesc" TEXT,
  "status" TEXT NOT NULL DEFAULT 'received',
  "rawCallback" JSONB NOT NULL DEFAULT '{}',
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MpesaCallbackLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");
CREATE INDEX "PasswordResetToken_email_createdAt_idx" ON "PasswordResetToken"("email", "createdAt");
CREATE INDEX "PasswordResetToken_userId_usedAt_expiresAt_idx" ON "PasswordResetToken"("userId", "usedAt", "expiresAt");
CREATE INDEX "StaffUser_ownerUserId_status_idx" ON "StaffUser"("ownerUserId", "status");
CREATE INDEX "StaffUser_email_idx" ON "StaffUser"("email");
CREATE INDEX "AuditLog_schoolOwnerId_createdAt_idx" ON "AuditLog"("schoolOwnerId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "MpesaCallbackLog_checkoutRequestId_idx" ON "MpesaCallbackLog"("checkoutRequestId");
CREATE INDEX "MpesaCallbackLog_userId_createdAt_idx" ON "MpesaCallbackLog"("userId", "createdAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffUser" ADD CONSTRAINT "StaffUser_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_schoolOwnerId_fkey" FOREIGN KEY ("schoolOwnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MpesaCallbackLog" ADD CONSTRAINT "MpesaCallbackLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
