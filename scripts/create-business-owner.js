#!/usr/bin/env node
/**
 * Хэрэглэгчийг business_owner болгох
 * node scripts/create-business-owner.js <email>
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Хэрэглээ: node scripts/create-business-owner.js <email>');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Хэрэглэгч олдсонгүй: ${email}`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { email },
    data: { role: 'business_owner' },
  });
  console.log(`Business owner болгосон: ${email}`);
  console.log('Энэ хэрэглэгч нэг эсвэл олон бизнес эзэмшиж байх ёстой (ownedBusinesses).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
