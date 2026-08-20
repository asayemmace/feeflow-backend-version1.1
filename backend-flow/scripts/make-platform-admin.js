import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/make-platform-admin.js your@email.com");
    process.exit(1);
  }

  const user = await prisma.user.update({
    where: { email },
    data: { isPlatformAdmin: true },
  });

  console.log(`Done: ${user.email} is now a platform admin.`);
}

main()
  .catch((e) => {
    console.error("Failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
