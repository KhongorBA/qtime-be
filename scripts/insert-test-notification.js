#!/usr/bin/env node
/**
 * Туршилтын notification бааз руу оруулах
 * Админ веб бэлэн болох хүртэл шалгахад ашиглана.
 *
 * Хэрэглээ: node scripts/insert-test-notification.js <userEmail> [title] [body]
 * Жишээ: node scripts/insert-test-notification.js user@example.com "Захиалга баталгаажлаа" "Таны захиалга 14:00 цагт баталгаажлаа"
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [email, title = 'Туршилтын мэдэгдэл', body = 'Энэ бол баазаас оруулсан туршилтын мэдэгдэл.'] =
    process.argv.slice(2);

  if (!email) {
    console.error('Хэрэглээ: node scripts/insert-test-notification.js <userEmail> [title] [body]');
    console.error('Жишээ: node scripts/insert-test-notification.js user@example.com');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Хэрэглэгч олдсонгүй: ${email}`);
    process.exit(1);
  }

  const n = await prisma.notification.create({
    data: {
      userId: user.id,
      title,
      body,
      read: false,
      data: { type: 'test', source: 'script' },
    },
  });

  console.log('Notification нэмэгдлээ:');
  console.log('  ID:', n.id);
  console.log('  User:', user.email);
  console.log('  Title:', n.title);
  console.log('  Body:', n.body);
  console.log('\nApp дээр Мэдэгдлүүд дэлгэц нээгээд дахин татаарай (pull-to-refresh).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
