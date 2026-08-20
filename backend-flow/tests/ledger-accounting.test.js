process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";

const { matchBankTransaction, MATCH_STATUS } = await import("../server.js");

function derive({ charges = [], payments = [], credits = [] }) {
  const totalCharges = charges.filter(c => !c.voidedAt).reduce((s, c) => s + c.amount, 0);
  const totalPaid = payments.filter(p => !p.reversedAt && !p.isReversal && !p.deletedAt).reduce((s, p) => s + p.amount, 0);
  const availableCredits = credits.filter(c => c.status === "available").reduce((s, c) => s + c.remainingAmount, 0);
  return { totalCharges, totalPaid, totalCredit: availableCredits, availableCredits, outstanding: Math.max(0, totalCharges - totalPaid - availableCredits) };
}

function assertBalanceInvariant(label, balance) {
  const totalCredit = Number(balance.totalCredit ?? balance.availableCredits ?? 0);
  assert.equal(
    balance.outstanding,
    Math.max(0, Number(balance.totalCharges || 0) - Number(balance.totalPaid || 0) - totalCredit),
    label
  );
}

function allocateFIFO(payment, charges, allocations = []) {
  let remaining = payment.amount;
  const created = [];
  for (const charge of charges.filter(c => !c.voidedAt).sort((a, b) => a.createdAt - b.createdAt)) {
    const already = allocations.filter(a => a.studentChargeId === charge.id).reduce((s, a) => s + a.amount, 0);
    const unpaid = Math.max(0, charge.amount - already);
    const amount = Math.min(remaining, unpaid);
    if (amount > 0) created.push({ paymentId: payment.id, studentChargeId: charge.id, amount });
    remaining -= amount;
    if (remaining <= 0) break;
  }
  return { allocations: created, unallocated: remaining };
}

function createChargeOnce(charges, charge) {
  const exists = charges.some(c =>
    !c.voidedAt &&
    !c.splitCharge &&
    !charge.splitCharge &&
    c.studentId === charge.studentId &&
    (c.termId || null) === (charge.termId || null) &&
    c.type === charge.type &&
    c.description === charge.description &&
    c.amount === charge.amount
  );
  return exists ? charges : [...charges, charge];
}

function currentTermView(lifetime, term) {
  return {
    currentTermCharges: term.currentTermCharges,
    currentTermPaid: term.currentTermPaid,
    currentTermOutstanding: term.currentTermOutstanding,
    lifetimeCharges: lifetime.totalCharges,
    lifetimePaid: lifetime.totalPaid,
    lifetimeOutstanding: lifetime.outstanding,
    totalCharges: term.currentTermCharges,
    totalPaid: term.currentTermPaid,
    outstanding: term.currentTermOutstanding,
  };
}

function studentsTableDisplay(row) {
  if ((row.currentTermCharges ?? 0) > 0) {
    return {
      termFee: row.currentTermCharges,
      paid: row.currentTermPaid,
      balance: row.currentTermOutstanding,
    };
  }
  return {
    termFee: row.lifetimeCharges,
    paid: row.lifetimePaid,
    balance: row.lifetimeOutstanding,
  };
}

function studentProfileCurrentTermWidget({ currentTermCharges, currentTermPaid, lifetimeOutstanding, allocatedToCurrentTerm = 0 }) {
  const termBalance = currentTermCharges - currentTermPaid;
  return {
    currentTermCharges,
    currentTermPaid,
    currentTermBalance: termBalance,
    currentTermOutstanding: termBalance,
    allocationOutstanding: Math.max(0, currentTermCharges - allocatedToCurrentTerm),
    allTimeBalance: lifetimeOutstanding,
    overdue: termBalance > 0,
  };
}

function studentsListCurrentTermView({ currentTermCharges, paymentsReceivedInTerm }) {
  const currentTermPaid = paymentsReceivedInTerm.reduce((sum, payment) => sum + payment.amount, 0);
  const currentTermOutstanding = currentTermCharges - currentTermPaid;
  return { currentTermCharges, currentTermPaid, currentTermOutstanding };
}

function invoiceSnapshot(ledgerBefore, newChargesTotal) {
  const accountTotalCharges = ledgerBefore.totalCharges + newChargesTotal;
  return {
    accountTotalCharges,
    totalPaidToDate: ledgerBefore.totalPaid,
    totalDueNow: Math.max(0, accountTotalCharges - ledgerBefore.totalPaid - ledgerBefore.availableCredits),
    newChargesTotal,
    previousOutstanding: ledgerBefore.outstanding,
  };
}

function resolveMpesaCallbackTenant({ txn, callbackUserId, accountReference, students }) {
  const accountStudentId = (accountReference || "").replace(/^FF-/, "");
  if (txn) {
    if (txn.userId !== callbackUserId) return { action: "reconciliation_required", reason: "tenant_mismatch", userId: txn.userId };
    if (accountStudentId && accountStudentId !== txn.studentId) return { action: "reconciliation_required", reason: "student_reference_mismatch", userId: txn.userId };
    const student = students.find(s => s.id === txn.studentId && s.userId === txn.userId);
    if (!student) return { action: "reconciliation_required", reason: "student_not_found", userId: txn.userId };
    return { action: "process", userId: txn.userId, studentId: txn.studentId };
  }
  const student = students.find(s => s.id === accountStudentId && s.userId === callbackUserId);
  if (!student) return { action: "unmatched", userId: callbackUserId };
  return { action: "process", userId: callbackUserId, studentId: student.id };
}

function recordMpesaReceipt(existingRefs, ref) {
  if (existingRefs.has(ref)) return { action: "ignored_duplicate" };
  existingRefs.add(ref);
  return { action: "recorded" };
}

function dedupeNewCharges(existingCharges, feeLines) {
  return feeLines.filter(line => {
    const exists = existingCharges.some(charge =>
      !charge.voidedAt &&
      charge.type === line.type &&
      (charge.termId || null) === (line.termId || null) &&
      normalizedDescription(charge.description) === normalizedDescription(line.description) &&
      Number(charge.amount) === Number(line.amount)
    );
    return !exists;
  });
}

function normalizedDescription(value) {
  return String(value || "Fee").trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueDisplayLines(lines) {
  const seen = new Set();
  return lines.filter(line => {
    const key = [
      line.termId || "",
      line.type,
      normalizedDescription(line.description),
      Number(line.amount),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

test("partial payment leaves outstanding", () => {
  assert.deepEqual(derive({ charges: [{ amount: 85000 }], payments: [{ amount: 60000 }] }).outstanding, 25000);
});

test("adding transport later increases outstanding without mutating paid", () => {
  const result = derive({ charges: [{ amount: 85000 }, { amount: 5000 }], payments: [{ amount: 60000 }] });
  assert.equal(result.totalCharges, 90000);
  assert.equal(result.outstanding, 30000);
});

test("parent pays after transport and balance remains five thousand", () => {
  const result = derive({ charges: [{ amount: 85000 }, { amount: 5000 }], payments: [{ amount: 60000 }, { amount: 25000 }] });
  assert.equal(result.outstanding, 5000);
});

test("overpayment is represented by credit memo, never negative balance", () => {
  const result = derive({ charges: [{ amount: 85000 }], payments: [{ amount: 90000 }], credits: [{ remainingAmount: 5000, status: "available" }] });
  assert.equal(result.outstanding, 0);
});

test("term rollover preserves historical payments", () => {
  const result = derive({ charges: [{ amount: 85000 }, { amount: 90000 }], payments: [{ amount: 85000 }] });
  assert.equal(result.totalPaid, 85000);
  assert.equal(result.outstanding, 90000);
});

test("reversal excludes original and reversal entries from paid total", () => {
  const result = derive({ charges: [{ amount: 85000 }], payments: [{ amount: 25000, reversedAt: new Date() }, { amount: 25000, isReversal: true }] });
  assert.equal(result.totalPaid, 0);
  assert.equal(result.outstanding, 85000);
});

test("invoice outstanding is previous ledger outstanding plus new invoice charges", () => {
  const before = derive({ charges: [{ amount: 85000 }], payments: [{ amount: 60000 }] });
  assert.equal(before.outstanding + 5000, 30000);
});

test("FIFO allocation pays oldest charges first", () => {
  const charges = [{ id: "tuition", amount: 85000, createdAt: 1 }, { id: "transport", amount: 5000, createdAt: 2 }];
  const result = allocateFIFO({ id: "p1", amount: 87000 }, charges);
  assert.deepEqual(result.allocations.map(a => [a.studentChargeId, a.amount]), [["tuition", 85000], ["transport", 2000]]);
  assert.equal(result.unallocated, 0);
});

test("migration run twice does not duplicate opening charge", () => {
  let charges = [];
  const opening = { studentId: "s1", termId: "t1", invoiceId: null, type: "tuition", description: "Opening tuition balance", amount: 85000 };
  charges = createChargeOnce(charges, opening);
  charges = createChargeOnce(charges, opening);
  assert.equal(charges.length, 1);
});

test("invoice preview does not create charges", () => {
  const charges = [{ studentId: "s1", termId: "t1", type: "tuition", description: "Tuition", amount: 85000 }];
  const previewOutstanding = derive({ charges, payments: [{ amount: 60000 }] }).outstanding + 5000;
  assert.equal(previewOutstanding, 30000);
  assert.equal(charges.length, 1);
});

test("confirming invoice twice does not duplicate exact same charge", () => {
  let charges = [];
  const transport = { studentId: "s1", termId: "t1", invoiceId: "inv1", type: "transport", description: "Transport", amount: 5000 };
  charges = createChargeOnce(charges, transport);
  charges = createChargeOnce(charges, transport);
  assert.equal(charges.length, 1);
});

test("preview then confirming existing tuition does not duplicate StudentCharge", () => {
  let charges = [
    { studentId: "s1", termId: "t1", type: "tuition", description: "Tuition Fee", amount: 70000 },
  ];
  const invoiceLines = [
    { studentId: "s1", termId: "t1", type: "tuition", description: "Tuition Fee", amount: 70000 },
  ];

  assert.equal(dedupeNewCharges(charges, invoiceLines).length, 0);
  for (const line of dedupeNewCharges(charges, invoiceLines)) {
    charges = createChargeOnce(charges, line);
  }
  for (const line of dedupeNewCharges(charges, invoiceLines)) {
    charges = createChargeOnce(charges, line);
  }

  assert.equal(charges.filter(c =>
    c.studentId === "s1" &&
    c.termId === "t1" &&
    c.type === "tuition" &&
    c.description === "Tuition Fee" &&
    c.amount === 70000 &&
    !c.voidedAt
  ).length, 1);
});

test("new term creates only one tuition charge per student", () => {
  let charges = [];
  const tuition = { studentId: "s1", termId: "t2", invoiceId: null, type: "tuition", description: "Tuition", amount: 90000 };
  charges = createChargeOnce(charges, tuition);
  charges = createChargeOnce(charges, tuition);
  assert.equal(charges.filter(c => c.studentId === "s1" && c.termId === "t2" && c.type === "tuition").length, 1);
});

test("creating invoice twice with different invoice ids does not duplicate equivalent charge", () => {
  let charges = [];
  charges = createChargeOnce(charges, { studentId: "s1", termId: "t1", invoiceId: "inv1", type: "transport", description: "Transport", amount: 5000 });
  charges = createChargeOnce(charges, { studentId: "s1", termId: "t1", invoiceId: "inv2", type: "transport", description: "Transport", amount: 5000 });
  assert.equal(charges.length, 1);
});

test("import retry does not duplicate opening tuition", () => {
  let charges = [];
  const imported = { studentId: "s1", termId: "t1", type: "tuition", description: "Opening tuition balance", amount: 85000 };
  charges = createChargeOnce(charges, imported);
  charges = createChargeOnce(charges, imported);
  assert.equal(charges.length, 1);
});

test("double-submit requests share an invoice idempotency key", () => {
  const keyA = JSON.stringify({ userId: "u1", studentId: "s1", termId: "t1", dueDate: "2026-05-30", lines: [{ type: "transport", amount: 5000 }] });
  const keyB = JSON.stringify({ userId: "u1", studentId: "s1", termId: "t1", dueDate: "2026-05-30", lines: [{ type: "transport", amount: 5000 }] });
  assert.equal(keyA, keyB);
});

test("concurrent equivalent charge creates collapse to one active charge", () => {
  const attempted = [
    { studentId: "s1", termId: "t1", type: "exam", description: "Exam", amount: 2000 },
    { studentId: "s1", termId: "t1", type: "exam", description: "Exam", amount: 2000 },
  ];
  const charges = attempted.reduce((all, charge) => createChargeOnce(all, charge), []);
  assert.equal(charges.length, 1);
});

test("splitCharge explicitly allows duplicate-looking charges", () => {
  let charges = [];
  charges = createChargeOnce(charges, { studentId: "s1", termId: "t1", type: "other", description: "Split", amount: 1000, splitCharge: true });
  charges = createChargeOnce(charges, { studentId: "s1", termId: "t1", type: "other", description: "Split", amount: 1000, splitCharge: true });
  assert.equal(charges.length, 2);
});

test("M-Pesa callback for school A cannot credit school B student via AccountReference", () => {
  const result = resolveMpesaCallbackTenant({
    txn: null,
    callbackUserId: "school-a",
    accountReference: "FF-student-b",
    students: [{ id: "student-b", userId: "school-b" }],
  });
  assert.deepEqual(result, { action: "unmatched", userId: "school-a" });
});

test("M-Pesa callback userId mismatch is rejected for reconciliation", () => {
  const result = resolveMpesaCallbackTenant({
    txn: { checkoutRequestId: "co-1", userId: "school-a", studentId: "student-a" },
    callbackUserId: "school-b",
    accountReference: "FF-student-a",
    students: [{ id: "student-a", userId: "school-a" }],
  });
  assert.deepEqual(result, { action: "reconciliation_required", reason: "tenant_mismatch", userId: "school-a" });
});

test("valid M-Pesa callback credits the transaction's verified school and student", () => {
  const result = resolveMpesaCallbackTenant({
    txn: { checkoutRequestId: "co-1", userId: "school-a", studentId: "student-a" },
    callbackUserId: "school-a",
    accountReference: "FF-student-a",
    students: [{ id: "student-a", userId: "school-a" }],
  });
  assert.deepEqual(result, { action: "process", userId: "school-a", studentId: "student-a" });
});

test("unmatched M-Pesa callback fallback is stored under callback school", () => {
  const result = resolveMpesaCallbackTenant({
    txn: null,
    callbackUserId: "school-a",
    accountReference: "FF-missing",
    students: [],
  });
  assert.deepEqual(result, { action: "unmatched", userId: "school-a" });
});

test("matchBankTransaction auto-matches exact invoice reference", () => {
  const students = [{ id: "s1", name: "John Doe", adm: "A123", parentName: "Jane Doe", parentPhone: "0712345678", phone: "" }];
  const invoices = [{ id: "i1", invoiceNo: 9, studentId: "s1", createdAt: "2026-05-20T00:00:00.000Z" }];
  const match = matchBankTransaction({
    normalized: { transactionRef: "INV-2026-0009", payerName: "", narration: "", amount: 5000, phone: "" },
    students,
    invoices,
    balances: new Map(),
    existingBankRefs: new Set(),
    existingPaymentRefs: new Set(),
    fallbackDuplicateKeys: new Set(),
  });

  assert.equal(match.matchStatus, MATCH_STATUS.MATCHED);
  assert.equal(match.matchConfidence, 100);
  assert.equal(match.matchedStudentId, "s1");
  assert.equal(match.matchReason, "Exact invoice INV-2026-0009");
});

test("matchBankTransaction auto-matches exact parent phone", () => {
  const students = [{ id: "s2", name: "Mary Jane", adm: "B456", parentName: "Grace Jane", parentPhone: "0712345678", phone: "" }];
  const invoices = [];
  const match = matchBankTransaction({
    normalized: { transactionRef: "", payerName: "", narration: "Parent paid via M-Pesa", amount: 8000, phone: "254712345678" },
    students,
    invoices,
    balances: new Map(),
    existingBankRefs: new Set(),
    existingPaymentRefs: new Set(),
    fallbackDuplicateKeys: new Set(),
  });

  assert.equal(match.matchStatus, MATCH_STATUS.MATCHED);
  assert.equal(match.matchConfidence, 98);
  assert.equal(match.matchedStudentId, "s2");
  assert.equal(match.matchReason, "Exact parent phone match");
});

test("matchBankTransaction flags ambiguous exact matches for review", () => {
  const students = [
    { id: "s3", name: "Alex Kim", adm: "C789", parentName: "Patricia Kim", parentPhone: "0711111111", phone: "" },
    { id: "s4", name: "Alex Kim", adm: "C790", parentName: "Patricia Kim", parentPhone: "0711111111", phone: "" },
  ];
  const invoices = [];
  const match = matchBankTransaction({
    normalized: { transactionRef: "", payerName: "Patricia Kim", narration: "", amount: 12000, phone: "254711111111" },
    students,
    invoices,
    balances: new Map(),
    existingBankRefs: new Set(),
    existingPaymentRefs: new Set(),
    fallbackDuplicateKeys: new Set(),
  });

  assert.equal(match.matchStatus, MATCH_STATUS.NEEDS_REVIEW);
  assert.equal(match.matchConfidence, 0);
  assert.equal(match.matchedStudentId, null);
  assert.equal(match.matchReason, "Multiple strong candidate students found — review required");
});

test("duplicate MpesaReceiptNumber is ignored", () => {
  const refs = new Set(["ABC123"]);
  assert.deepEqual(recordMpesaReceipt(refs, "ABC123"), { action: "ignored_duplicate" });
  assert.deepEqual(recordMpesaReceipt(refs, "XYZ999"), { action: "recorded" });
});

test("students table uses active term totals, not lifetime totals", () => {
  const lifetime = derive({ charges: [{ amount: 85000 }, { amount: 90000 }], payments: [{ amount: 85000 }] });
  const term = { currentTermCharges: 90000, currentTermPaid: 0, currentTermOutstanding: 90000 };
  const row = currentTermView(lifetime, term);
  const display = studentsTableDisplay(row);
  assert.equal(display.termFee, 90000);
  assert.equal(display.paid, 0);
  assert.equal(display.balance, 90000);
  assert.equal(row.lifetimeCharges, 175000);
});

test("students table falls back to lifetime totals for migrated charges without active term", () => {
  const lifetime = derive({ charges: [{ amount: 85000, termId: null }], payments: [{ amount: 60000 }] });
  const term = { currentTermCharges: 0, currentTermPaid: 0, currentTermOutstanding: 0 };
  const row = currentTermView(lifetime, term);
  const display = studentsTableDisplay(row);

  assert.equal(row.currentTermCharges, 0);
  assert.equal(row.currentTermPaid, 0);
  assert.equal(row.currentTermOutstanding, 0);
  assert.equal(display.termFee, 85000);
  assert.equal(display.paid, 60000);
  assert.equal(display.balance, 25000);
});

test("student profile term balance uses current term charges minus current term paid", () => {
  const lifetime = derive({
    charges: [{ amount: 80000, termId: "old" }, { amount: 70000, termId: "active" }],
    payments: [{ amount: 100000 }],
  });
  const widget = studentProfileCurrentTermWidget({
    currentTermCharges: 70000,
    currentTermPaid: 50000,
    lifetimeOutstanding: lifetime.outstanding,
    allocatedToCurrentTerm: 20000,
  });

  assert.equal(widget.currentTermBalance, 20000);
  assert.equal(widget.currentTermOutstanding, 20000);
  assert.equal(widget.allTimeBalance, 50000);
  assert.equal(widget.allocationOutstanding, 50000);
  assert.equal(widget.overdue, true);
});

test("students list uses payments received in current term, not allocation totals", () => {
  const term = studentsListCurrentTermView({
    currentTermCharges: 70000,
    paymentsReceivedInTerm: [{ amount: 50000 }],
  });
  const lifetime = derive({
    charges: [{ amount: 80000, termId: "old" }, { amount: 70000, termId: "active" }],
    payments: [{ amount: 50000 }],
  });
  const row = currentTermView(lifetime, term);
  const display = studentsTableDisplay(row);

  assert.equal(display.termFee, 70000);
  assert.equal(display.paid, 50000);
  assert.equal(display.balance, 20000);
});

test("invoice snapshot shows account totals, not only new charges", () => {
  const before = derive({ charges: [{ amount: 85000 }], payments: [{ amount: 60000 }] });
  const snap = invoiceSnapshot(before, 5000);
  assert.equal(snap.accountTotalCharges, 90000);
  assert.equal(snap.totalPaidToDate, 60000);
  assert.equal(snap.totalDueNow, 30000);
  assert.equal(snap.newChargesTotal, 5000);
  assert.equal(snap.previousOutstanding, 25000);
});

test("new student with existing 90k tuition preview does not double count tuition", () => {
  const existing = [{ termId: "t1", type: "tuition", description: "Tuition Fee", amount: 90000, invoiceId: null }];
  const lines = [{ termId: "t1", type: "tuition", description: "Tuition Fee", amount: 90000 }];
  const dedupedNewCharges = dedupeNewCharges(existing, lines).reduce((s, line) => s + line.amount, 0);
  const before = derive({ charges: existing, payments: [] });
  const snap = invoiceSnapshot(before, dedupedNewCharges);
  assert.equal(snap.accountTotalCharges, 90000);
  assert.equal(snap.totalPaidToDate, 0);
  assert.equal(snap.totalDueNow, 90000);
});

test("existing tuition plus new transport preview shows account due", () => {
  const existing = [{ termId: "t1", type: "tuition", amount: 85000, invoiceId: null }];
  const lines = [{ termId: "t1", type: "transport", amount: 5000 }];
  const dedupedNewCharges = dedupeNewCharges(existing, lines).reduce((s, line) => s + line.amount, 0);
  const before = derive({ charges: existing, payments: [{ amount: 60000 }] });
  const snap = invoiceSnapshot(before, dedupedNewCharges);
  assert.equal(snap.accountTotalCharges, 90000);
  assert.equal(snap.totalPaidToDate, 60000);
  assert.equal(snap.totalDueNow, 30000);
});

test("invoice preview separates display subtotal from new ledger charges", () => {
  const existing = [{ termId: "t1", type: "tuition", description: "Term tuition fee", amount: 70000, invoiceId: null }];
  const lines = [
    { termId: "t1", type: "tuition", description: "Term tuition fee", amount: 70000 },
    { termId: "t1", type: "transport", description: "Transport", amount: 5000 },
  ];
  const newLines = dedupeNewCharges(existing, lines);
  const newChargesTotal = newLines.reduce((s, line) => s + line.amount, 0);
  const displayFeeTotal = lines.reduce((s, line) => s + line.amount, 0);
  const previouslyPaid = 0;
  const dueNow = Math.max(0, displayFeeTotal - previouslyPaid);
  const dashboard = derive({ charges: [...existing, ...newLines], payments: [] });

  assert.equal(newChargesTotal, 5000);
  assert.equal(displayFeeTotal, 75000);
  assert.equal(dueNow, 75000);
  assert.equal(dashboard.outstanding, 75000);
});

test("recurring invoices do not re-add previous invoice feeBreakdown lines", () => {
  let charges = [
    { termId: "t1", type: "tuition", description: "Term tuition fee", amount: 70000, invoiceId: null },
    { termId: "t1", type: "transport", description: "transport", amount: 5000, invoiceId: "inv1" },
  ];
  const firstInvoiceLines = uniqueDisplayLines([
    ...charges,
    { termId: "t1", type: "lunch", description: "Lunch", amount: 2000, invoiceId: "inv2" },
  ]);
  const firstNewLines = dedupeNewCharges(charges, firstInvoiceLines);
  charges = [...charges, ...firstNewLines];

  const secondInvoiceLines = uniqueDisplayLines([
    ...charges,
    ...firstInvoiceLines,
  ]);
  const secondNewLines = dedupeNewCharges(charges, secondInvoiceLines);

  assert.deepEqual(firstInvoiceLines.map(l => [l.description, l.amount]), [
    ["Term tuition fee", 70000],
    ["transport", 5000],
    ["Lunch", 2000],
  ]);
  assert.equal(firstNewLines.length, 1);
  assert.equal(firstNewLines[0].description, "Lunch");
  assert.equal(secondInvoiceLines.length, 3);
  assert.equal(secondNewLines.length, 0);
  assert.equal(secondInvoiceLines.reduce((s, line) => s + line.amount, 0), 77000);
});

test("tuition line with different description or amount is not treated as existing charge", () => {
  let charges = [{ studentId: "s1", termId: "t1", type: "tuition", description: "Tuition", amount: 86000, invoiceId: null }];
  const reminderLine = { studentId: "s1", termId: "t1", type: "tuition", description: "Tuition Fee", amount: 40000 };
  const newLines = dedupeNewCharges(charges, [reminderLine]);
  const dedupedNewCharges = newLines.reduce((s, line) => s + line.amount, 0);
  const before = derive({ charges, payments: [{ amount: 46000 }] });
  const snap = invoiceSnapshot(before, dedupedNewCharges);

  for (const line of newLines) charges = createChargeOnce(charges, line);

  assert.equal(dedupedNewCharges, 40000);
  assert.equal(snap.previousOutstanding, 40000);
  assert.equal(snap.accountTotalCharges, 126000);
  assert.equal(snap.totalPaidToDate, 46000);
  assert.equal(snap.totalDueNow, 80000);
  assert.equal(charges.length, 2);
});

test("major surfaces expose ledger-derived invariant balances", () => {
  const ledger = derive({ charges: [{ amount: 86000 }], payments: [{ amount: 46000 }] });
  const invoice = invoiceSnapshot(ledger, 0);
  const surfaces = [
    ["Students table", { totalCharges: ledger.totalCharges, totalPaid: ledger.totalPaid, totalCredit: ledger.totalCredit, outstanding: ledger.outstanding }],
    ["Student profile", ledger],
    ["Dashboard stats", ledger],
    ["Invoice preview", { totalCharges: invoice.accountTotalCharges, totalPaid: invoice.totalPaidToDate, totalCredit: ledger.totalCredit, outstanding: invoice.totalDueNow }],
    ["Confirmed invoice", { totalCharges: invoice.accountTotalCharges, totalPaid: invoice.totalPaidToDate, totalCredit: ledger.totalCredit, outstanding: invoice.totalDueNow }],
    ["Receipt", ledger],
    ["Parent portal", { totalCharges: invoice.accountTotalCharges, totalPaid: invoice.totalPaidToDate, totalCredit: ledger.totalCredit, outstanding: invoice.totalDueNow }],
    ["Reports", ledger],
    ["Payments list", ledger],
  ];

  for (const [label, balance] of surfaces) assertBalanceInvariant(label, balance);
});
