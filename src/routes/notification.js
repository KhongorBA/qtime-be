import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

export const notificationRoutes = express.Router();

// All routes require auth
notificationRoutes.use(protect);

// Order matters: specific paths before /:id

// GET /api/notifications/unread-count
notificationRoutes.get('/unread-count', async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, read: false },
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/notifications/read-all
notificationRoutes.put('/read-all', async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/notifications/register-device - FCM token
notificationRoutes.post(
  '/register-device',
  [
    body('fcmToken').trim().notEmpty(),
    body('fcmApp').optional().isIn(['consumer', 'business']).withMessage('fcmApp must be consumer or business'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { fcmToken } = req.body;
      const fcmApp = req.body.fcmApp === 'business' ? 'business' : 'consumer';
      await prisma.userDevice.upsert({
        where: { fcmToken },
        create: { userId: req.user.id, fcmToken, fcmApp },
        update: { userId: req.user.id, fcmApp },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PUT /api/notifications/:id/read
notificationRoutes.put('/:id/read', async (req, res) => {
  try {
    const n = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!n) return res.status(404).json({ message: 'Notification not found' });

    await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/notifications/test-send - шинэ мэдэгдэл илгээх (realtime шалгах)
notificationRoutes.post(
  '/test-send',
  [body('title').trim().notEmpty(), body('body').optional().trim()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { title, body: bodyText } = req.body;
      const userId = req.user.id;

      // 1. DB-д мэдэгдэл үүсгэх (in-app list-д харагдана)
      const notif = await prisma.notification.create({
        data: { userId, title, body: bodyText || '', data: { type: 'test' } },
      });

      // 2. FCM push — бүх төхөөрөмж (consumer + business токенууд)
      const devices = await prisma.userDevice.findMany({
        where: { userId },
        select: { fcmToken: true, fcmApp: true },
      });
      const fcmResults = [];
      for (const dev of devices) {
        if (!dev.fcmToken) continue;
        const app = dev.fcmApp === 'business' ? 'business' : 'consumer';
        fcmResults.push(
          await sendFcmMessage(
            dev.fcmToken,
            { title, body: bodyText || '' },
            { id: notif.id, type: 'test' },
            app,
          ),
        );
      }
      const fcmResult =
        fcmResults.length === 0
          ? { success: false, error: 'FCM token бүртгэгдээгүй байна. App-д нэвтэрч register-device ажиллана.' }
          : { success: fcmResults.some((r) => r.success), attempts: fcmResults };

      res.json({
        notification: { id: notif.id, title: notif.title, body: notif.body, createdAt: notif.createdAt },
        fcm: fcmResult,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// GET /api/notifications - list notifications
notificationRoutes.get('/', async (req, res) => {
  try {
    const { unreadOnly, limit, offset } = req.query;
    const where = { userId: req.user.id };
    if (unreadOnly === 'true') where.read = false;

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50,
      skip: offset ? parseInt(offset, 10) : 0,
    });

    res.json(notifications.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      read: n.read,
      data: n.data,
      createdAt: n.createdAt.toISOString(),
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
