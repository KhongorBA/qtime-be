import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../../config/db.js';
import { sendFcmMessage } from '../../utils/firebaseAdmin.js';

export const notificationsRouter = express.Router();

// POST /api/admin/notifications/send - notification илгээх
notificationsRouter.post(
  '/send',
  [
    body('title').trim().notEmpty(),
    body('body').optional().trim(),
    body('userIds').optional().isArray(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { title, body: bodyText, userIds } = req.body;

      const where = userIds?.length ? { userId: { in: userIds } } : {};
      const devices = await prisma.userDevice.findMany({
        where,
        select: { userId: true, fcmToken: true, fcmApp: true },
      });

      const created = [];
      const sent = [];
      const failed = [];

      for (const dev of devices) {
        const notif = await prisma.notification.create({
          data: {
            userId: dev.userId,
            title,
            body: bodyText || '',
            data: { type: 'admin', source: 'admin_panel' },
          },
        });
        created.push(notif.id);

        const result = await sendFcmMessage(
          dev.fcmToken,
          { title, body: bodyText || '' },
          { id: notif.id, type: 'admin' },
          dev.fcmApp === 'business' ? 'business' : 'consumer',
        );
        if (result.success) sent.push(dev.userId);
        else failed.push({ userId: dev.userId, error: result.error });
      }

      res.json({
        created: created.length,
        sent: sent.length,
        failed: failed.length,
        details: failed.length ? failed : undefined,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);
