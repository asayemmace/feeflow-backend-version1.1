# FeeFlow School Branding

## Prisma migration

Migration: `prisma/migrations/20260515130000_school_branding/migration.sql`

Adds nullable fields to `User` for backward compatibility:

- `schoolLogoUrl`
- `schoolLogoPath`
- `schoolTagline`
- `schoolPrimaryColor`
- `schoolSecondaryColor`

Existing schools keep the initials fallback until a logo is uploaded.

## Routes

- `GET /api/settings/branding` returns public branding values for the authenticated school workspace.
- `PATCH /api/settings/branding` updates tagline and optional hex colors.
- `POST /api/settings/logo` uploads a logo as multipart form field `logo`.
- `DELETE /api/settings/logo` removes the current logo and safely deletes the stored file.

All routes require `requireAuth`. Staff users need `settings.view` or `settings.edit`; owners are allowed automatically.

## Upload storage

Local storage uses `uploads/logos` from the backend working directory. The API stores the internal filesystem path in `schoolLogoPath` and returns only `schoolLogoUrl` to clients.

Production recommendation: mount `uploads/logos` on persistent storage or replace the write/delete helpers with S3/R2/Cloudinary while keeping the same DB fields and route contracts.

## Security and performance

- Accepted formats: PNG, JPG/JPEG, WEBP.
- Maximum size: 2MB.
- Upload middleware checks declared MIME type and image magic bytes.
- Filenames are sanitized and replaced with generated unique names.
- Path traversal is blocked before writing or deleting files.
- Old logo files are deleted only after the DB points to the new logo.
- Public `/uploads` responses use long-lived cache headers and `X-Content-Type-Options: nosniff`.

The current implementation keeps PDFs fast by rejecting oversized uploads. For heavier production image optimization, add Sharp in the upload route to resize to 512px and encode WEBP/PNG before writing.
