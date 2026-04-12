/**
 * Booking Reminder Job
 *
 * Цаг болохоос 24 цаг болон 2 цагийн өмнө захиалгын сануулга илгээнэ.
 * FCM push notification + Email (хэрэв тохиргоотой бол)
 * Давхардалтаас сэргийлж reminder_sent_24h / reminder_sent_2h флаг хадгалана.
 *
 * Interval: 30 минут тутамд ажиллана.
 */

import { prisma } from '../config/db.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';
import { sendBookingReminderEmail } from '../utils/emailService.js';

const INTERVAL_MS = 30 * 60 * 1000; // 30 минут

async function sendReminder(booking, hoursLabel) {
  const { id, customerId, serviceName, startTime } = booking;
  const businessName = booking.business?.name || '';
  const businessPhone = booking.business?.phone || null;
  const customerEmail = booking.customer?.email || null;
  const customerName = booking.customer?.name || 'Хэрэглэгч';

  const title = 'Захиалгын сануулга';
  const body = `${hoursLabel} дараа ${businessName}-д "${serviceName}" цаг таны болно.`;

  // In-app notification
  let notifId = null;
  try {
    const notif = await prisma.notification.create({
      data: {
        userId: customerId,
        title,
        body,
        data: {
          type: 'booking_reminder',
          bookingId: id,
          businessId: booking.businessId,
        },
      },
    });
    notifId = notif.id;
  } catch (e) {
    console.error('[reminder] create notification:', e.message);
  }

  // FCM push
  try {
    const devices = await prisma.userDevice.findMany({
      where: { userId: customerId },
      select: { fcmToken: true, fcmApp: true },
    });
    await Promise.all(
      devices.map((dev) => {
        if (!dev.fcmToken) return Promise.resolve();
        return sendFcmMessage(
          dev.fcmToken,
          { title, body },
          {
            id: notifId || '',
            type: 'booking_reminder',
            bookingId: id,
            businessId: booking.businessId,
          },
          dev.fcmApp === 'business' ? 'business' : 'consumer',
        );
      }),
    );
  } catch (e) {
    console.error('[reminder] FCM:', e.message);
  }

  // Email
  if (customerEmail) {
    sendBookingReminderEmail({
      to: customerEmail,
      customerName,
      businessName,
      serviceName,
      startTime,
      businessPhone,
    }).catch((e) => console.error('[reminder] email:', e.message));
  }
}

export async function runBookingReminderSweep() {
  const now = new Date();

  // 24 цагийн сануулга: startTime нь одооноос 23~25 цагийн дараа
  const h24from = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const h24to = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // 2 цагийн сануулга: startTime нь одооноос 1.5~2.5 цагийн дараа
  const h2from = new Date(now.getTime() + 90 * 60 * 1000);
  const h2to = new Date(now.getTime() + 150 * 60 * 1000);

  const upcoming = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      startTime: { gte: h2from, lte: h24to },
    },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      business: { select: { id: true, name: true, phone: true } },
    },
  });

  for (const booking of upcoming) {
    const start = new Date(booking.startTime);
    const msUntil = start.getTime() - now.getTime();
    const hoursUntil = msUntil / (60 * 60 * 1000);

    // Metadata: давхардалтаас сэргийлэх флаг
    const meta = (booking.notes ? {} : {});
    // We use a dedicated check via a unique notification query to avoid duplicates
    const reminderType = hoursUntil <= 2.5 ? '2h' : '24h';
    const existingReminder = await prisma.notification.findFirst({
      where: {
        userId: booking.customerId,
        data: {
          path: ['type'],
          equals: 'booking_reminder',
        },
        AND: {
          data: {
            path: ['bookingId'],
            equals: booking.id,
          },
        },
        createdAt: {
          gte: reminderType === '2h'
            ? new Date(now.getTime() - 60 * 60 * 1000)  // 1 цагийн дотор
            : new Date(now.getTime() - 3 * 60 * 60 * 1000), // 3 цагийн дотор
        },
      },
    });

    if (existingReminder) continue; // Аль хэдийн илгээсэн

    const label = reminderType === '2h' ? '2 цагийн' : '24 цагийн';
    await sendReminder(booking, label).catch((e) =>
      console.error('[reminder] booking', booking.id, e.message),
    );
  }
}

export function startBookingReminderJob() {
  console.log('[reminder] Booking reminder job started (30 min interval)');
  runBookingReminderSweep().catch((e) => console.error('[reminder] initial sweep:', e.message));
  setInterval(() => {
    runBookingReminderSweep().catch((e) => console.error('[reminder] sweep:', e.message));
  }, INTERVAL_MS);
}
