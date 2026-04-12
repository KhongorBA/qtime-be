import { prisma } from '../config/db.js';
import { getPlatformConfig } from '../utils/platformConfig.js';

/**
 * Middleware: checks that the target business has an active subscription
 * before allowing a booking to be created.
 *
 * Reads businessId from req.body.businessId or req.params.businessId.
 * If no subscription record exists yet, auto-creates a trial.
 * Fails open on unexpected errors so a DB issue never blocks bookings silently
 * — just logs the error and continues.
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const businessId = req.body?.businessId || req.params?.businessId;
    if (!businessId) return next();

    let sub = await prisma.businessSubscription.findUnique({ where: { businessId } });

    // Auto-create trial on first booking attempt
    if (!sub) {
      const cfg = await getPlatformConfig();
      const trialDays = parseInt(cfg.trial_days || '90', 10);
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);
      sub = await prisma.businessSubscription.create({
        data: { businessId, trialStartedAt: now, trialEndsAt, status: 'trial' },
      });
    }

    const now = new Date();

    if (sub.status === 'trial') {
      if (now > sub.trialEndsAt) {
        await prisma.businessSubscription.update({
          where: { businessId },
          data: { status: 'expired' },
        });
        return res.status(403).json({
          code: 'SUBSCRIPTION_EXPIRED',
          message: 'Энэ бизнесийн туршилтын хугацаа дууссан тул захиалга авах боломжгүй.',
        });
      }
      return next();
    }

    if (sub.status === 'active') return next();

    if (sub.status === 'grace') {
      const graceEnd = sub.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd.getTime() + 3 * 86_400_000)
        : null;
      if (graceEnd && now > graceEnd) {
        await prisma.businessSubscription.update({
          where: { businessId },
          data: { status: 'expired' },
        });
        return res.status(403).json({
          code: 'SUBSCRIPTION_EXPIRED',
          message: 'Энэ бизнесийн захиалга авах эрх хаагдсан.',
        });
      }
      return next(); // still within 3-day grace
    }

    // expired or unknown status
    return res.status(403).json({
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Энэ бизнес одоогоор захиалга авах боломжгүй.',
    });
  } catch (err) {
    console.error('[requireSubscription] error:', err.message);
    next(); // fail open — don't silently break bookings on infra error
  }
};
