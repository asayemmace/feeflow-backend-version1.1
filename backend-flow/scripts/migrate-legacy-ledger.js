import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function createStudentChargeSafe(tx, data) {
  const amount = Number(data.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const existing = await tx.studentCharge.findFirst({
    where: {
      studentId: data.studentId,
      termId: data.termId || null,
      type: data.type,
      description: data.description,
      amount,
      voidedAt: null,
      splitCharge: false,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (existing) return existing;
  return tx.studentCharge.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      studentId: data.studentId,
      userId: data.userId,
      termId: data.termId || null,
      type: data.type,
      description: data.description,
      amount,
      idempotencyKey: data.id,
    },
    update: {},
  });
}

async function allocatePaymentFIFO(paymentId, tx) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.reversedAt || payment.isReversal || payment.deletedAt) return;
  const existing = await tx.paymentAllocation.count({ where: { paymentId } });
  if (existing) return;

  const charges = await tx.studentCharge.findMany({
    where: { studentId: payment.studentId, voidedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const sums = await tx.paymentAllocation.groupBy({
    by: ["studentChargeId"],
    where: { studentChargeId: { in: charges.map(c => c.id) }, payment: { reversedAt: null, isReversal: false, deletedAt: null } },
    _sum: { amount: true },
  });
  const allocatedByCharge = Object.fromEntries(sums.map(s => [s.studentChargeId, Number(s._sum.amount || 0)]));

  let remaining = payment.amount;
  for (const charge of charges) {
    if (remaining <= 0) break;
    const unpaid = Math.max(0, charge.amount - (allocatedByCharge[charge.id] || 0));
    if (unpaid <= 0) continue;
    const amount = Math.min(remaining, unpaid);
    await tx.paymentAllocation.create({ data: { paymentId, studentChargeId: charge.id, amount } });
    remaining -= amount;
  }
}

async function main() {
  const students = await prisma.student.findMany({ where: { deletedAt: null } });
  for (const student of students) {
    await prisma.$transaction(async (tx) => {
      const chargeCount = await tx.studentCharge.count({ where: { studentId: student.id, voidedAt: null } });
      if (chargeCount === 0 && student.fee > 0) {
        await createStudentChargeSafe(tx, {
          id: `mig_charge_${student.id}`,
          studentId: student.id,
          userId: student.userId,
          termId: student.termId || null,
          type: "tuition",
          description: "Opening tuition balance",
          amount: student.fee,
        });
      }

      const paymentCount = await tx.payment.count({ where: { studentId: student.id, deletedAt: null, reversedAt: null, isReversal: false } });
      if (paymentCount === 0 && student.paid > 0) {
        await tx.payment.upsert({
          where: { id: `mig_payment_${student.id}` },
          create: { id: `mig_payment_${student.id}`, amount: student.paid, method: "migration_opening_balance", studentId: student.id, userId: student.userId, termId: student.termId || null },
          update: {},
        });
      }

      const payments = await tx.payment.findMany({ where: { studentId: student.id, deletedAt: null, reversedAt: null, isReversal: false }, orderBy: { createdAt: "asc" } });
      for (const payment of payments) await allocatePaymentFIFO(payment.id, tx);

      const [charges, paid, existingCredits] = await Promise.all([
        tx.studentCharge.aggregate({ where: { studentId: student.id, voidedAt: null }, _sum: { amount: true } }),
        tx.payment.aggregate({ where: { studentId: student.id, deletedAt: null, reversedAt: null, isReversal: false }, _sum: { amount: true } }),
        tx.creditMemo.count({ where: { studentId: student.id, status: "available" } }),
      ]);
      const excess = Math.max(0, Number(paid._sum.amount || 0) - Number(charges._sum.amount || 0));
      if (excess > 0 && existingCredits === 0) {
        await tx.creditMemo.create({
          data: { studentId: student.id, userId: student.userId, termId: student.termId || null, amount: excess, remainingAmount: excess, status: "available", note: "Migrated legacy overpayment credit" },
        });
      }
    });
  }
  console.log(`Migrated ${students.length} students to strict ledger rows.`);
}

main().finally(() => prisma.$disconnect());
