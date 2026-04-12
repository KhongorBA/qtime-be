import { prisma } from '../config/db.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

const TEN_MIN_MS = 10 * 60 * 1000;

/**
 * pending + createdAt > 10 минут → owner_timeout, хэрэглэгчид мэдэгдэл + FCM.
 */
export async function runPendingBookingTimeoutSweep() {
  const cutoff = new Date(Date.now() - TEN_MIN_MS);
  const stale = await prisma.booking.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
    },
    include: {
      customer: { select: { id: true, name: true } },
      business: { select: { id: true, name: true } },
    },
  });

  for (const b of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        const cur = await tx.booking.findUnique({
          where: { id: b.id },
          select: { status: true },
        });
        if (!cur || cur.status !== 'pending') return;

        await tx.booking.update({
          where: { id: b.id },
          data: { status: 'owner_timeout' },
        });
        await tx.bookingStatusLog.create({
          data: {
            bookingId: b.id,
            oldStatus: 'pending',
            newStatus: 'owner_timeout',
            changedById: null,
            note: 'Автомат — 10 минут дотор бизнес хариу өгөөгүй',
          },
        });
      });
    } catch (e) {
      console.error('[pending-timeout] booking', b.id, e.message);
      continue;
    }

    const title = 'Захиалгын төлөв';
    const body = `${b.business.name}: Бизнес эрхлэгч хариу үйлдэл хийгээгүй.`;

    try {
      const notif = await prisma.notification.create({
        data: {
          userId: b.customerId,
          title,
          body,
          data: {
            type: 'booking_status',
            bookingId: b.id,
            businessId: b.businessId,
            status: 'owner_timeout',
          },
        },
      });

      const devices = await prisma.userDevice.findMany({
        where: { userId: b.customerId },
        select: { fcmToken: true, fcmApp: true },
      });
      await Promise.all(
        devices.map((dev) => {
          if (!dev.fcmToken) return Promise.resolve();
          return sendFcmMessage(
            dev.fcmToken,
            { title, body },
            {
              id: notif.id,
              type: 'booking_status',
              bookingId: b.id,
              businessId: b.businessId,
              status: 'owner_timeout',
            },
            dev.fcmApp === 'business' ? 'business' : 'consumer',
          );
        }),
      );
    } catch (e) {
      console.error('[pending-timeout] notify customer', b.id, e.message);
    }
  }
}
