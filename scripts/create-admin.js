#!/usr/bin/env node
/**
 * Admin хэрэглэгч үүсгэх эсвэл одоогийн хэрэглэгчийг admin болгох
 * node scripts/create-admin.js <email>
 * node scripts/create-admin.js admin@example.com
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Хэрэглээ: node scripts/create-admin.js <email>');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Хэрэглэгч олдсонгүй: ${email}`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { email },
    data: { role: 'admin' },
  });
  console.log(`Admin болгосон: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
