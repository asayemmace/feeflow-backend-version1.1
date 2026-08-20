-- School branding fields are nullable for backward compatibility.
-- Existing FeeFlow schools keep their current initials/avatar fallback until they upload a logo.
ALTER TABLE "User" ADD COLUMN "schoolLogoUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "schoolLogoPath" TEXT;
ALTER TABLE "User" ADD COLUMN "schoolTagline" TEXT;
ALTER TABLE "User" ADD COLUMN "schoolPrimaryColor" TEXT;
ALTER TABLE "User" ADD COLUMN "schoolSecondaryColor" TEXT;
