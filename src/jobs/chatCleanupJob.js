import { prisma } from '../config/db.js';

const RETENTION_DAYS = 2;

export async function runChatCleanup() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.message.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      console.log(`[chat-cleanup] Deleted ${count} messages older than ${RETENTION_DAYS} days`);
    }
  } catch (e) {
    console.error('[chat-cleanup] Error:', e);
  }
}

export function startChatCleanupJob() {
  // Run once at startup, then every 6 hours
  runChatCleanup();
  setInterval(runChatCleanup, 6 * 60 * 60 * 1000);
}
