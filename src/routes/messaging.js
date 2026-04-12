import express from 'express';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
export const messagingRoutes = router;

router.use(protect);

// ─── Conversations ────────────────────────────────────────────────────────────

// GET /messages/conversations — list my conversations (customer view)
router.get('/conversations', async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { customerId: req.user.id },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        business: { select: { id: true, name: true, images: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, imageUrl: true, readAt: true, createdAt: true, senderId: true },
        },
      },
    });
    res.json(conversations);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /messages/business/:businessId/conversations — list conversations for a business (owner/staff)
router.get('/business/:businessId/conversations', async (req, res) => {
  const { businessId } = req.params;
  try {
    const member = await prisma.businessMember.findFirst({
      where: { businessId, userId: req.user.id, status: 'approved' },
    });
    const owner = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.user.id } });
    if (!member && !owner) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });

    const conversations = await prisma.conversation.findMany({
      where: { businessId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, avatar: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, imageUrl: true, readAt: true, createdAt: true, senderId: true },
        },
      },
    });
    res.json(conversations);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /messages/conversations — start or get existing conversation (customer)
router.post('/conversations', async (req, res) => {
  const { businessId } = req.body;
  if (!businessId) return res.status(400).json({ message: 'businessId заавал' });
  try {
    const conversation = await prisma.conversation.upsert({
      where: { businessId_customerId: { businessId, customerId: req.user.id } },
      update: {},
      create: { businessId, customerId: req.user.id },
      include: {
        business: { select: { id: true, name: true, images: true } },
      },
    });
    res.json(conversation);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /messages/unread-count — total unread messages for current user
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.user.id;

    // Count unread as customer
    const customerCount = await prisma.message.count({
      where: {
        senderId: { not: userId },
        readAt: null,
        conversation: { customerId: userId },
      },
    });

    // Count unread as business owner/member
    const ownedBusinesses = await prisma.business.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    const memberBusinesses = await prisma.businessMember.findMany({
      where: { userId, status: 'approved' },
      select: { businessId: true },
    });
    const businessIds = [
      ...ownedBusinesses.map((b) => b.id),
      ...memberBusinesses.map((m) => m.businessId),
    ];

    let businessCount = 0;
    if (businessIds.length > 0) {
      businessCount = await prisma.message.count({
        where: {
          senderId: { not: userId },
          readAt: null,
          conversation: { businessId: { in: businessIds } },
        },
      });
    }

    res.json({ count: customerCount + businessCount });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────

// GET /messages/:conversationId — get messages
router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const { cursor, limit = 30 } = req.query;
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return res.status(404).json({ message: 'Яриа олдсонгүй' });
    if (conv.customerId !== req.user.id) {
      const member = await prisma.businessMember.findFirst({
        where: { businessId: conv.businessId, userId: req.user.id, status: 'approved' },
      });
      const owner = await prisma.business.findFirst({ where: { id: conv.businessId, ownerId: req.user.id } });
      if (!member && !owner) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      include: { sender: { select: { id: true, name: true, avatar: true } } },
    });

    // Mark messages from others as read
    await prisma.message.updateMany({
      where: { conversationId, senderId: { not: req.user.id }, readAt: null },
      data: { readAt: new Date() },
    });

    res.json(messages.reverse());
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /messages/:conversationId — send a message
router.post('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const { content, imageUrl } = req.body;
  const trimmedContent = content?.trim() ?? '';
  const trimmedImage = imageUrl?.trim() ?? '';
  if (!trimmedContent && !trimmedImage) {
    return res.status(400).json({ message: 'Мессеж хоосон байна' });
  }
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return res.status(404).json({ message: 'Яриа олдсонгүй' });
    if (conv.customerId !== req.user.id) {
      const member = await prisma.businessMember.findFirst({
        where: { businessId: conv.businessId, userId: req.user.id, status: 'approved' },
      });
      const owner = await prisma.business.findFirst({ where: { id: conv.businessId, ownerId: req.user.id } });
      if (!member && !owner) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });
    }

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: req.user.id,
          content: trimmedContent,
          ...(trimmedImage ? { imageUrl: trimmedImage } : {}),
        },
        include: { sender: { select: { id: true, name: true, avatar: true } } },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);

    res.status(201).json(message);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
