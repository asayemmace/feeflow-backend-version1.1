import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const studentName = process.argv.slice(2).join(" ").trim();
  const students = await prisma.student.findMany({
    where: {
      deletedAt: null,
      ...(studentName ? { name: { contains: studentName, mode: "insensitive" } } : {}),
    },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, adm: true, cls: true },
  });
  const studentIds = students.map(s => s.id);
  const charges = await prisma.studentCharge.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: [{ studentId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, studentId: true, termId: true, invoiceId: true, type: true,
      description: true, amount: true, createdAt: true, voidedAt: true,
    },
  });
  const studentById = Object.fromEntries(students.map(s => [s.id, s]));
  console.table(charges.map(c => ({
    student: studentById[c.studentId]?.name || c.studentId,
    adm: studentById[c.studentId]?.adm || "",
    class: studentById[c.studentId]?.cls || "",
    chargeId: c.id,
    termId: c.termId || "",
    invoiceId: c.invoiceId || "",
    type: c.type,
    description: c.description,
    amount: c.amount,
    createdAt: c.createdAt.toISOString(),
    voidedAt: c.voidedAt ? c.voidedAt.toISOString() : "",
  })));
}

main().finally(() => prisma.$disconnect());
