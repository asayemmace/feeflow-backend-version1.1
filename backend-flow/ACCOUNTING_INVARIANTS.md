# Accounting Invariants

FeeFlow uses append-only ledger accounting for student balances.

Deprecated cache fields:
- `Student.fee`
- `Student.paid`

These fields may exist for legacy display compatibility, but they are not valid inputs for accounting math.

Authoritative formula:

```text
totalCharges =
  SUM(StudentCharge.amount where voidedAt is null)

totalPaid =
  SUM(Payment.amount
      where reversedAt is null
      and isReversal = false
      and deletedAt is null)

availableCredits =
  SUM(CreditMemo.remainingAmount
      where status = "available")

outstanding =
  max(0, totalCharges - totalPaid - availableCredits)
```

Rules:
- Every fee item is a `StudentCharge` row.
- Adding transport, exam, lunch, or tuition later inserts a new charge row.
- Payments are immutable. Reversing a payment marks the original row and creates a reversal row.
- Payments allocate FIFO to the oldest unpaid `StudentCharge` rows through `PaymentAllocation`.
- Term rollover closes the old term and creates a new one. It never resets payments or historical balances.
- Negative balances are not displayed as negative outstanding; they must be represented as `CreditMemo` rows.
- Dashboard totals, invoices, receipts, profile balances, and reports must call the shared balance derivation path.
- All charge creation must go through `createStudentChargeSafe(...)`.
- A normal active charge is unique by `studentId + termId + type + amount + description`.
- Duplicate-looking active charges are allowed only when explicitly marked `splitCharge=true`.
- Invoice confirmation uses an idempotency key so double-clicks and retries return the existing invoice instead of creating duplicate charges.
- Invoice preview is read-only and must never insert ledger rows.
- Invoice creation, charge creation, payment creation, FIFO allocations, and credit creation must be transaction-wrapped when part of the same user action.

Operations:
- Startup logs a warning if duplicate active charges are detected.
- Audit all students with `npm run ledger:audit`.
- Repair duplicate active charges with `npm run ledger:audit -- --repair`; this sets `voidedAt` and never deletes rows.

Migration:
- Run Prisma migrations.
- Run `node scripts/migrate-legacy-ledger.js` once for legacy databases to convert `Student.fee` into opening `StudentCharge` rows, `Student.paid` into opening `Payment` rows where missing, and FIFO allocations.
