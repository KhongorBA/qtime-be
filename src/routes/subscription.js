/**
 * Subscription routes
 *
 * GET  /api/subscriptions/status/:businessId  — owner checks own status
 * POST /api/subscriptions/activate/:businessId — admin activates paid plan
 * POST /api/subscriptions/expire/:businessId   — admin force-expire (testing)
 * GET  /api/subscriptions/admin/list           — admin: all subscriptions
 * GET  /api/subscriptions/config               — admin: view platform config
 * PATCH /api/subscriptions/config              — admin: edit platform config
 */

import express from 'express';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { getPlatformConfig } from '../utils/platformConfig.js';

export const subscriptionRoutes = express.Router();
subscriptionRoutes.use(protect);

// Helper: ensure subscription record exists for a business
async function getOrCreateSubscription(businessId) {
  let sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) {
    const cfg = await getPlatformConfig();
    const trialDays = parseInt(cfg.trial_days || '90', 10);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);
    sub = await prisma.businessSubscription.create({
      data: { businessId, trialStartedAt: now, trialEndsAt, status: 'trial' },
    });
  }
  return sub;
}

// ---------------------------------------------------------------------------
// GET /api/subscriptions/status/:businessId
// Business owner (or admin) checks subscription status + days remaining.
// ---------------------------------------------------------------------------
subscriptionRoutes.get('/status/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { ownerId: true },
    });
    if (!business) return res.status(404).json({ message: 'Business олдсонгүй' });

    const isMember = await prisma.businessMember.findFirst({
      where: { businessId, userId: req.user.id, status: 'approved' },
    });
    const canView = business.ownerId === req.user.id
      || isMember
      || req.user.role === 'admin';
    if (!canView) return res.status(403).json({ message: 'Зөвшөөрөлгүй' });

    const sub = await getOrCreateSubscription(businessId);
    const now = new Date();

    let daysLeft = null;
    if (sub.status === 'trial') {
      daysLeft = Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000));
    } else if (sub.currentPeriodEnd) {
      daysLeft = Math.max(0, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000));
    }

    res.json({ ...sub, daysLeft });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/activate/:businessId  (admin only)
// Activates a paid subscription for a given duration.
// ---------------------------------------------------------------------------
subscriptionRoutes.post('/activate/:businessId', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });

    const { businessId } = req.params;
    const months = Number(req.body.months ?? 1);
    if (months < 1 || months > 24) {
      return res.status(400).json({ message: 'months must be 1–24' });
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + months * 30 * 86_400_000);

    const sub = await prisma.businessSubscription.upsert({
      where: { businessId },
      create: {
        businessId,
        trialStartedAt: now,
        trialEndsAt: now,   // trial already over
        status: 'active',
        currentPeriodEnd: periodEnd,
      },
      update: {
        status: 'active',
        currentPeriodEnd: periodEnd,
        warningSent7d: false,
        warningSent3d: false,
        warningSent1d: false,
      },
    });

    res.json(sub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions/expire/:businessId  (admin only, for testing)
// ---------------------------------------------------------------------------
subscriptionRoutes.post('/expire/:businessId', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });

    const sub = await prisma.businessSubscription.update({
      where: { businessId: req.params.businessId },
      data: { status: 'expired' },
    });
    res.json(sub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions/admin/list  (admin only)
// ---------------------------------------------------------------------------
subscriptionRoutes.get('/admin/list', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });

    const { status, page = 1, limit = 50 } = req.query;
    const where = status ? { status } : {};

    const [total, subs] = await prisma.$transaction([
      prisma.businessSubscription.count({ where }),
      prisma.businessSubscription.findMany({
        where,
        include: {
          business: { select: { id: true, name: true, category: true, ownerId: true } },
        },
        orderBy: { trialEndsAt: 'asc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
    ]);

    res.json({ total, page: Number(page), limit: Number(limit), data: subs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions/config  (admin only)
// ---------------------------------------------------------------------------
subscriptionRoutes.get('/config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
    const rows = await prisma.platformConfig.findMany({ orderBy: { key: 'asc' } });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/config  (admin only)
// Body: { deposit_percent, platform_fee_percent, refund_percent, trial_days, currency }
// ---------------------------------------------------------------------------
subscriptionRoutes.patch('/config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });

    const allowed = ['deposit_percent', 'platform_fee_percent', 'refund_percent', 'trial_days', 'currency'];
    const ops = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        ops.push(
          prisma.platformConfig.upsert({
            where: { key },
            create: { key, value: String(req.body[key]) },
            update: { value: String(req.body[key]) },
          }),
        );
      }
    }
    if (ops.length === 0) return res.status(400).json({ message: 'Өөрчлөх утга байхгүй' });

    await prisma.$transaction(ops);
    const updated = await prisma.platformConfig.findMany({ orderBy: { key: 'asc' } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
