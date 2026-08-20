import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const shouldVoidDuplicates = args.includes("--void-duplicates") || args.includes("--repair");
const query = args.filter(arg => !arg.startsWith("--")).join(" ").trim();

function usage() {
  console.error("Usage: node scripts/debug-student-ledger.js <admission-number-or-name> [--void-duplicates]");
}

function iso(value) {
  return value ? new Date(value).toISOString() : "";
}

function sum(rows, getter) {
  return rows.reduce((total, row) => total + Number(getter(row) || 0), 0);
}

function chargeDuplicateKey(charge) {
  return [
    charge.studentId,
    charge.termId || "",
    charge.type || "",
    Number(charge.amount || 0).toFixed(2),
    charge.description || "",
  ].join("|");
}

async function findOneStudent(search) {
  const baseWhere = { deletedAt: null };
  const exactAdm = await prisma.student.findMany({
    where: { ...baseWhere, adm: { equals: search, mode: "insensitive" } },
    orderBy: [{ name: "asc" }],
  });
  if (exactAdm.length === 1) return exactAdm[0];

  const exactName = await prisma.student.findMany({
    where: { ...baseWhere, name: { equals: search, mode: "insensitive" } },
    orderBy: [{ name: "asc" }],
  });
  if (exactName.length === 1) return exactName[0];

  const candidates = await prisma.student.findMany({
    where: {
      ...baseWhere,
      OR: [
        { adm: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ],
    },
    orderBy: [{ name: "asc" }, { adm: "asc" }],
    take: 20,
  });

  if (candidates.length === 1) return candidates[0];

  if (!candidates.length) {
    console.error(`No student found for "${search}".`);
    process.exitCode = 1;
    return null;
  }

  console.error(`More than one student matched "${search}". Re-run with an exact adm/name:`);
  console.table(candidates.map(s => ({
    id: s.id,
    name: s.name,
    adm: s.adm || "",
    class: s.cls || "",
  })));
  process.exitCode = 1;
  return null;
}

async function loadLedger(studentId) {
  const [charges, payments, credits] = await Promise.all([
    prisma.studentCharge.findMany({
      where: { studentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        allocations: {
          where: { payment: { reversedAt: null, isReversal: false, deletedAt: null } },
          select: { amount: true },
        },
      },
    }),
    prisma.payment.findMany({
      where: { studentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.creditMemo.findMany({
      where: { studentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { charges, payments, credits };
}

function computeTotals({ charges, payments, credits }) {
  const totalCharges = sum(charges.filter(c => !c.voidedAt), c => c.amount);
  const totalPaid = sum(
    payments.filter(p => !p.reversedAt && !p.isReversal && !p.deletedAt),
    p => p.amount,
  );
  const totalCredit = sum(credits.filter(c => c.status === "available"), c => c.remainingAmount);
  const outstanding = Math.max(0, totalCharges - totalPaid - totalCredit);
  return { totalCharges, totalPaid, totalCredit, outstanding };
}

function findDuplicateCharges(charges) {
  const groups = new Map();
  for (const charge of charges.filter(c => !c.voidedAt && !c.splitCharge)) {
    const key = chargeDuplicateKey(charge);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(charge);
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => {
      const ranked = [...group].sort((a, b) => {
        const aAllocated = sum(a.allocations || [], x => x.amount);
        const bAllocated = sum(b.allocations || [], x => x.amount);
        return bAllocated - aAllocated
          || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          || a.id.localeCompare(b.id);
      });
      return {
        keep: ranked[0],
        duplicates: ranked.slice(1),
      };
    });
}

function printLedger(student, ledger, totals) {
  console.log("\nStudent");
  console.table([{
    id: student.id,
    name: student.name,
    adm: student.adm || "",
    legacyFee: student.fee || 0,
    legacyPaid: student.paid || 0,
  }]);

  console.log("\nStudentCharge rows");
  console.table(ledger.charges.map(c => ({
    id: c.id,
    termId: c.termId || "",
    invoiceId: c.invoiceId || "",
    type: c.type,
    description: c.description,
    amount: c.amount,
    voidedAt: iso(c.voidedAt),
    createdAt: iso(c.createdAt),
  })));

  console.log("\nPayment rows");
  console.table(ledger.payments.map(p => ({
    id: p.id,
    amount: p.amount,
    method: p.method,
    reversedAt: iso(p.reversedAt),
    isReversal: p.isReversal,
    deletedAt: iso(p.deletedAt),
    createdAt: iso(p.createdAt),
  })));

  console.log("\nCreditMemo rows");
  console.table(ledger.credits.map(c => ({
    amount: c.amount,
    remainingAmount: c.remainingAmount,
    status: c.status,
  })));

  console.log("\nComputed ledger totals");
  console.table([{
    totalCharges: totals.totalCharges,
    totalPaid: totals.totalPaid,
    credits: totals.totalCredit,
    outstanding: totals.outstanding,
    formula: "max(0, totalCharges - totalPaid - credits)",
  }]);
}

async function main() {
  if (!query) {
    usage();
    process.exitCode = 1;
    return;
  }

  const student = await findOneStudent(query);
  if (!student) return;

  let ledger = await loadLedger(student.id);
  let totals = computeTotals(ledger);
  printLedger(student, ledger, totals);

  const duplicateGroups = findDuplicateCharges(ledger.charges);
  const duplicateRows = duplicateGroups.flatMap(group => group.duplicates);
  const duplicateInflation = sum(duplicateRows, c => c.amount);
  const projectedOutstanding = Math.max(0, totals.totalCharges - duplicateInflation - totals.totalPaid - totals.totalCredit);

  console.log("\nDuplicate StudentCharge diagnosis");
  if (!duplicateGroups.length) {
    console.log("No active duplicate charge groups found for studentId + termId + type + amount + description.");
  } else {
    console.table(duplicateGroups.flatMap(group => group.duplicates.map(d => ({
      keepChargeId: group.keep.id,
      duplicateChargeId: d.id,
      termId: d.termId || "",
      invoiceId: d.invoiceId || "",
      type: d.type,
      description: d.description,
      amount: d.amount,
      createdAt: iso(d.createdAt),
    }))));
    console.table([{
      activeDuplicateRows: duplicateRows.length,
      duplicateInflation,
      currentOutstanding: totals.outstanding,
      projectedOutstandingAfterVoiding: projectedOutstanding,
    }]);
  }

  if (shouldVoidDuplicates && duplicateRows.length) {
    const result = await prisma.studentCharge.updateMany({
      where: { id: { in: duplicateRows.map(c => c.id) }, voidedAt: null },
      data: {
        voidedAt: new Date(),
        voidReason: "Duplicate charge voided by debug-student-ledger.js",
      },
    });
    console.log(`\nVoided ${result.count} duplicate StudentCharge row(s). No rows were deleted.`);

    ledger = await loadLedger(student.id);
    totals = computeTotals(ledger);
    console.log("\nTotals after repair");
    console.table([{
      totalCharges: totals.totalCharges,
      totalPaid: totals.totalPaid,
      credits: totals.totalCredit,
      outstanding: totals.outstanding,
      formula: "max(0, totalCharges - totalPaid - credits)",
    }]);
  } else if (duplicateRows.length) {
    console.log("\nDry run only. Re-run with --void-duplicates to void the duplicate charge rows.");
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
