# FeeFlow Security Route Notes

## Password Reset
- `POST /api/auth/forgot-password` - generic response, creates hashed 15-minute reset code.
- `POST /api/auth/verify-reset-code` - validates code, max 5 wrong attempts, returns short-lived reset token.
- `POST /api/auth/reset-password` - marks reset row used and updates `passwordChangedAt`.

## Staff / RBAC
- `GET /api/staff` - list staff, requires owner or `staff.manage`.
- `POST /api/staff/invite` - Max plan only, creates invited staff and emails 48-hour invite link.
- `POST /api/staff/accept-invite` - staff creates their own password.
- `PATCH /api/staff/:id` - update staff details/permissions.
- `DELETE /api/staff/:id` - marks staff removed.

## Signed Document Links
- `POST /api/invoices/:id/regenerate-link` - creates a new 30-day signed invoice link.
- `POST /api/receipts/:id/regenerate-link` - creates a new 90-day signed receipt link.
- `GET /i/:token`, `GET /i/:token/pdf`, `GET /r/:token`, `GET /r/:token/pdf`, `/p/:invoiceToken`, and public pay routes verify signed tokens. Legacy random tokens remain readable for already-issued links.

## M-Pesa Callback
- `POST /api/mpesa/callback/:userId?secret=...` or header `x-mpesa-callback-secret`.
- Requires callback secret, required Safaricom fields, matching pending `CheckoutRequestID`, tenant, amount, phone, and student reference.
- Stores sanitized callback payload in `MpesaCallbackLog`.
