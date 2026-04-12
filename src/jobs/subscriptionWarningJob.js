/**
 * Subscription Warning Job
 *
 * Runs every 12 hours (twice a day as required).
 * Sends FCM notifications + creates in-app notifications for:
 *   - 7 days before trial/subscription expiry
 *   - 3 days before expiry
 *   - 1 day before expiry
 *
 * Also transitions expired subscriptions from 'trial' → 'expired'
 * and 'active' → 'grace' (3-day grace period).
 */

import { prisma } from '../config/db.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

async function notifyOwner(businessId, title, body) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { ownerId: true, name: true },
  });
  if (!business) return;

  // Create in-app notification
  let notif;
  try {
    notif = await prisma.notification.create({
      data: {
        userId: business.ownerId,
        title,
        body,
        data: { type: 'subscription', businessId },
      },
    });
  } catch (e) {
    console.error('[subscriptionWarning] create notification:', e.message);
    return;
  }

  // Send FCM push to business app
  const devices = await prisma.userDevice.findMany({
    where: { userId: business.ownerId },
    select: { fcmToken: true, fcmApp: true },
  });
  await Promise.all(
    devices.map((d) =>
      sendFcmMessage(
        d.fcmToken,
        { title, body },
        { id: notif.id, type: 'subscription', businessId },
        d.fcmApp === 'business' ? 'business' : 'consumer',
      ),
    ),
  );
}

export async function runSubscriptionWarningJob() {
  const now = new Date();
  console.log('[subscriptionWarning] Running at', now.toISOString());

  try {
    // ----------------------------------------------------------------
    // 1. Warn at 7 / 3 / 1 days before trial expiry
    // ----------------------------------------------------------------
    const trialSubs = await prisma.businessSubscription.findMany({
      where: {
        status: 'trial',
        trialEndsAt: { gt: now },
      },
    });

    for (const sub of trialSubs) {
      const daysLeft = Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000);

      if (daysLeft <= 7 && !sub.warningSent7d) {
        await notifyOwner(
          sub.businessId,
          '⚠️ Trial дуусахад 7 хоног үлдлээ',
          'Subscription идэвхжүүлэхгүй бол 7 хоногийн дараа захиалга авах эрх хаагдана.',
        );
        await prisma.businessSubscription.update({
          where: { id: sub.id },
          data: { warningSent7d: true },
        });
      }

      if (daysLeft <= 3 && !sub.warningSent3d) {
        await notifyOwner(
          sub.businessId,
          '🔴 Trial дуусахад 3 хоног үлдлээ',
          'Subscription идэвхжүүлэхгүй бол 3 хоногийн дараа захиалга авах эрх хаагдана.',
        );
        await prisma.businessSubscription.update({
          where: { id: sub.id },
          data: { warningSent3d: true },
        });
      }

      if (daysLeft <= 1 && !sub.warningSent1d) {
        await notifyOwner(
          sub.businessId,
          '🚨 Trial маргааш дуусна!',
          'Өнөөдөр subscription идэвхжүүлэхгүй бол маргааш захиалга авах эрх хаагдана.',
        );
        await prisma.businessSubscription.update({
          where: { id: sub.id },
          data: { warningSent1d: true },
        });
      }
    }

    // ----------------------------------------------------------------
    // 2. Warn at 7 / 3 / 1 days before active subscription expiry
    // ----------------------------------------------------------------
    const activeSubs = await prisma.businessSubscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { not: null, gt: now },
      },
    });

    for (const sub of activeSubs) {
      if (!sub.currentPeriodEnd) continue;
      const daysLeft = Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000);

      if (daysLeft <= 7 && !sub.warningSent7d) {
        await notifyOwner(
          sub.businessId,
          '⚠️ Subscription дуусахад 7 хоног үлдлээ',
          'Дараагийн төлбөрөө цагт хийнэ үү.',
        );
        await prisma.businessSubscription.update({ where: { id: sub.id }, data: { warningSent7d: true } });
      }
      if (daysLeft <= 3 && !sub.warningSent3d) {
        await notifyOwner(
          sub.businessId,
          '🔴 Subscription дуусахад 3 хоног үлдлээ',
          'Дараагийн төлбөрөө хийхгүй бол захиалга авах эрх хязгаарлагдана.',
        );
        await prisma.businessSubscription.update({ where: { id: sub.id }, data: { warningSent3d: true } });
      }
      if (daysLeft <= 1 && !sub.warningSent1d) {
        await notifyOwner(
          sub.businessId,
          '🚨 Subscription маргааш дуусна!',
          'Өнөөдөр төлбөрөө хийхгүй бол маргааш захиалга авах эрх хаагдана.',
        );
        await prisma.businessSubscription.update({ where: { id: sub.id }, data: { warningSent1d: true } });
      }
    }

    // ----------------------------------------------------------------
    // 3. Expire overdue trial subscriptions
    // ----------------------------------------------------------------
    const expiredTrials = await prisma.businessSubscription.findMany({
      where: { status: 'trial', trialEndsAt: { lte: now } },
      select: { id: true, businessId: true },
    });
    for (const sub of expiredTrials) {
      await prisma.businessSubscription.update({
        where: { id: sub.id },
        data: { status: 'expired' },
      });
      await notifyOwner(
        sub.businessId,
        '🔒 Trial дууслаа — захиалга хаагдлаа',
        'Subscription идэвхжүүлснээр захиалга авах эрхээ сэргээнэ үү.',
      );
    }

    // ----------------------------------------------------------------
    // 4. Move overdue active subscriptions → grace
    // ----------------------------------------------------------------
    const overdueActive = await prisma.businessSubscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { not: null, lte: now },
      },
      select: { id: true, businessId: true },
    });
    for (const sub of overdueActive) {
      await prisma.businessSubscription.update({
        where: { id: sub.id },
        data: { status: 'grace', warningSent7d: false, warningSent3d: false, warningSent1d: false },
      });
      await notifyOwner(
        sub.businessId,
        '⚠️ Subscription дууссан — 3 хоногийн хүлцэл',
        'Төлбөрөө 3 хоногийн дотор хийхгүй бол захиалга авах эрх хаагдана.',
      );
    }

    // ----------------------------------------------------------------
    // 5. Expire grace-period subscriptions after 3 days
    // ----------------------------------------------------------------
    const expiredGrace = await prisma.businessSubscription.findMany({
      where: {
        status: 'grace',
        currentPeriodEnd: { not: null, lte: new Date(now.getTime() - 3 * 86_400_000) },
      },
      select: { id: true, businessId: true },
    });
    for (const sub of expiredGrace) {
      await prisma.businessSubscription.update({
        where: { id: sub.id },
        data: { status: 'expired' },
      });
      await notifyOwner(
        sub.businessId,
        '🔒 Subscription бүрэн хаагдлаа',
        'Subscription сунгахын тулд admin-д хандана уу.',
      );
    }

    console.log(
      `[subscriptionWarning] Done — warned trials: ${trialSubs.length}, active: ${activeSubs.length},` +
      ` expired trials: ${expiredTrials.length}, grace: ${overdueActive.length}, expired grace: ${expiredGrace.length}`,
    );
  } catch (err) {
    console.error('[subscriptionWarning] Job error:', err.message);
  }
}

/** Start the job — runs immediately, then every 12 hours */
export function startSubscriptionWarningJob() {
  runSubscriptionWarningJob();
  setInterval(runSubscriptionWarningJob, TWELVE_HOURS_MS);
}
