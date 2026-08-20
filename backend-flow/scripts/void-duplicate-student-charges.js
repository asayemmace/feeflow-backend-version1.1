import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const groups = await prisma.studentCharge.groupBy({
    by: ["studentId", "termId", "type", "amount", "description"],
    where: { voidedAt: null },
    _count: { id: true },
  });

  let voided = 0;
  for (const group of groups.filter(g => g._count.id > 1)) {
    const charges = await prisma.studentCharge.findMany({
      where: {
        studentId: group.studentId,
        termId: group.termId,
        type: group.type,
        amount: group.amount,
        description: group.description,
        voidedAt: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, allocations: { where: { payment: { reversedAt: null, isReversal: false, deletedAt: null } }, select: { amount: true } } },
    });
    const ranked = charges
      .map(c => ({ ...c, allocated: c.allocations.reduce((s, a) => s + a.amount, 0) }))
      .sort((a, b) => b.allocated - a.allocated || a.id.localeCompare(b.id));
    const duplicates = ranked.slice(1);
    if (!duplicates.length) continue;
    const result = await prisma.studentCharge.updateMany({
      where: { id: { in: duplicates.map(c => c.id) }, voidedAt: null },
      data: { voidedAt: new Date(), voidReason: "Duplicate charge voided by ledger cleanup script" },
    });
    voided += result.count;
  }

  console.log(`Voided ${voided} duplicate StudentCharge row(s).`);
}

main().finally(() => prisma.$disconnect());
