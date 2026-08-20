import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const shouldRepair = process.argv.includes("--repair");

function amount(value) {
  return Number(value || 0);
}

function iso(value) {
  return value ? new Date(value).toISOString() : "";
}

function sum(rows, getter) {
  return rows.reduce((total, row) => total + amount(getter(row)), 0);
}

function duplicateKey(charge) {
  return [
    charge.studentId,
    charge.termId || "",
    charge.type || "",
    amount(charge.amount).toFixed(2),
    charge.description || "",
  ].join("|");
}

function calculateBalance({ charges, payments, credits }) {
  const totalCharges = sum(charges.filter(c => !c.voidedAt), c => c.amount);
  const totalPaid = sum(
    payments.filter(p => !p.reversedAt && !p.isReversal && !p.deletedAt),
    p => p.amount,
  );
  const totalCredits = sum(credits.filter(c => c.status === "available"), c => c.remainingAmount);
  const outstanding = Math.max(0, totalCharges - totalPaid - totalCredits);
  return { totalCharges, totalPaid, totalCredits, outstanding };
}

function findDuplicateGroups(charges) {
  const groups = new Map();
  for (const charge of charges.filter(c => !c.voidedAt && !c.splitCharge)) {
    const key = duplicateKey(charge);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(charge);
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => {
      const sorted = [...group].sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        || a.id.localeCompare(b.id)
      );
      return {
        keep: sorted[0],
        duplicates: sorted.slice(1),
      };
    });
}

function impossibleStates(student, balance) {
  const issues = [];
  if (balance.outstanding < 0) issues.push("negative outstanding");
  if (balance.outstanding > balance.totalCharges) issues.push("outstanding > totalCharges");
  if (balance.totalPaid > balance.totalCharges && balance.totalCredits < balance.totalPaid - balance.totalCharges) {
    issues.push("totalPaid > totalCharges without matching credits");
  }
  if (balance.totalCharges === 0 && balance.outstanding > 0) issues.push("charges = 0 but outstanding > 0");
  return issues.map(issue => ({
    student: student.name,
    adm: student.adm || "",
    issue,
    totalCharges: balance.totalCharges,
    totalPaid: balance.totalPaid,
    totalCredits: balance.totalCredits,
    outstanding: balance.outstanding,
  }));
}

async function main() {
  console.log(shouldRepair ? "Ledger audit running in REPAIR mode." : "Ledger audit running in DRY-RUN mode.");

  const students = await prisma.student.findMany({
    where: { deletedAt: null },
    orderBy: [{ name: "asc" }, { adm: "asc" }],
    select: { id: true, name: true, adm: true },
  });
  const studentIds = students.map(s => s.id);

  const [charges, payments, credits] = await Promise.all([
    prisma.studentCharge.findMany({
      where: { studentId: { in: studentIds } },
      orderBy: [{ studentId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        studentId: true,
        termId: true,
        invoiceId: true,
        type: true,
        description: true,
        amount: true,
        splitCharge: true,
        voidedAt: true,
        createdAt: true,
      },
    }),
    prisma.payment.findMany({
      where: { studentId: { in: studentIds } },
      select: {
        studentId: true,
        amount: true,
        reversedAt: true,
        isReversal: true,
        deletedAt: true,
      },
    }),
    prisma.creditMemo.findMany({
      where: { studentId: { in: studentIds } },
      select: {
        studentId: true,
        remainingAmount: true,
        status: true,
      },
    }),
  ]);

  const chargesByStudent = new Map();
  const paymentsByStudent = new Map();
  const creditsByStudent = new Map();
  for (const student of students) {
    chargesByStudent.set(student.id, []);
    paymentsByStudent.set(student.id, []);
    creditsByStudent.set(student.id, []);
  }
  for (const charge of charges) chargesByStudent.get(charge.studentId)?.push(charge);
  for (const payment of payments) paymentsByStudent.get(payment.studentId)?.push(payment);
  for (const credit of credits) creditsByStudent.get(credit.studentId)?.push(credit);

  const studentRows = [];
  const duplicateRows = [];
  const rowsToVoid = [];
  const manualReview = [];
  let duplicateGroupsFound = 0;

  for (const student of students) {
    const ledger = {
      charges: chargesByStudent.get(student.id) || [],
      payments: paymentsByStudent.get(student.id) || [],
      credits: creditsByStudent.get(student.id) || [],
    };
    const balance = calculateBalance(ledger);
    const duplicateGroups = findDuplicateGroups(ledger.charges);
    duplicateGroupsFound += duplicateGroups.length;

    for (const group of duplicateGroups) {
      const invoiceIds = [...new Set(group.duplicates.concat(group.keep).map(c => c.invoiceId || ""))].filter(Boolean);
      for (const duplicate of group.duplicates) {
        rowsToVoid.push(duplicate);
        duplicateRows.push({
          student: student.name,
          adm: student.adm || "",
          keepChargeId: group.keep.id,
          duplicateChargeId: duplicate.id,
          termId: duplicate.termId || "",
          invoiceId: duplicate.invoiceId || "",
          type: duplicate.type,
          description: duplicate.description,
          amount: duplicate.amount,
          createdAt: iso(duplicate.createdAt),
          invoiceIdsInGroup: invoiceIds.join(", "),
          safety: invoiceIds.length > 1 ? "same charge key across invoices" : "same charge key",
        });
      }
    }

    manualReview.push(...impossibleStates(student, balance));
    studentRows.push({
      student: student.name,
      adm: student.adm || "",
      activeCharges: ledger.charges.filter(c => !c.voidedAt).length,
      duplicateGroups: duplicateGroups.length,
      totalCharges: balance.totalCharges,
      totalPaid: balance.totalPaid,
      totalCredits: balance.totalCredits,
      outstanding: balance.outstanding,
    });
  }

  const beforeInflatedAmount = sum(rowsToVoid, c => c.amount);

  console.log("\nStudent balance audit");
  console.table(studentRows);

  console.log("\nDuplicate active StudentCharge rows");
  if (duplicateRows.length) console.table(duplicateRows);
  else console.log("No duplicate active StudentCharge rows found.");

  let voidedCount = 0;
  let repairedStudentIds = new Set();
  if (shouldRepair && rowsToVoid.length) {
    const result = await prisma.studentCharge.updateMany({
      where: { id: { in: rowsToVoid.map(c => c.id) }, voidedAt: null },
      data: {
        voidedAt: new Date(),
        voidReason: "Duplicate charge voided by all-student ledger audit",
      },
    });
    voidedCount = result.count;
    repairedStudentIds = new Set(rowsToVoid.map(c => c.studentId));
  } else if (!shouldRepair && rowsToVoid.length) {
    console.log("\nDry run only. Re-run with --repair to void later duplicate rows.");
  }

  const afterCharges = shouldRepair
    ? await prisma.studentCharge.findMany({
        where: { studentId: { in: studentIds } },
        select: {
          id: true,
          studentId: true,
          termId: true,
          invoiceId: true,
          type: true,
          description: true,
          amount: true,
          splitCharge: true,
          voidedAt: true,
          createdAt: true,
        },
      })
    : charges;

  const afterChargesByStudent = new Map(students.map(s => [s.id, []]));
  for (const charge of afterCharges) afterChargesByStudent.get(charge.studentId)?.push(charge);

  const afterDuplicateRows = [];
  const afterManualReview = [];
  for (const student of students) {
    const ledger = {
      charges: afterChargesByStudent.get(student.id) || [],
      payments: paymentsByStudent.get(student.id) || [],
      credits: creditsByStudent.get(student.id) || [],
    };
    const balance = calculateBalance(ledger);
    for (const group of findDuplicateGroups(ledger.charges)) {
      afterDuplicateRows.push(...group.duplicates);
    }
    afterManualReview.push(...impossibleStates(student, balance));
  }
  const afterInflatedAmount = sum(afterDuplicateRows, c => c.amount);

  console.log("\nRepair summary");
  console.table([{
    studentsScanned: students.length,
    duplicateGroupsFound,
    duplicateRowsVoided: voidedCount,
    beforeTotalInflatedAmount: beforeInflatedAmount,
    afterTotalInflatedAmount: afterInflatedAmount,
    studentsRepairedSuccessfully: repairedStudentIds.size,
    studentsNeedingManualReview: afterManualReview.length,
  }]);

  console.log("\nRemaining impossible states");
  if (afterManualReview.length) console.table(afterManualReview);
  else console.log("None.");

  console.log("\nFinal");
  console.log(`Before total inflated amount: ${beforeInflatedAmount}`);
  console.log(`After total inflated amount: ${afterInflatedAmount}`);
  console.log(`Students repaired successfully: ${repairedStudentIds.size}`);
  console.log(`Students needing manual review: ${afterManualReview.length}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
