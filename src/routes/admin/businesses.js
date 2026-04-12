import express from 'express';
import { prisma } from '../../config/db.js';

export const businessesRouter = express.Router();

// GET /api/admin/businesses - бүх бизнес, status filter
businessesRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const where = status ? { status } : {};
    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit, 10),
      }),
      prisma.business.count({ where }),
    ]);
    res.json({ businesses, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/businesses/:id/approve
businessesRouter.patch('/:id/approve', async (req, res) => {
  try {
    const b = await prisma.business.update({
      where: { id: req.params.id },
      data: { status: 'approved' },
      include: { owner: { select: { name: true, email: true } } },
    });
    res.json(b);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/businesses/:id/reject
businessesRouter.patch('/:id/reject', async (req, res) => {
  try {
    const b = await prisma.business.update({
      where: { id: req.params.id },
      data: { status: 'rejected' },
    });
    res.json(b);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/businesses/:id/verify — toggle verification badge
businessesRouter.patch('/:id/verify', async (req, res) => {
  try {
    const { verified } = req.body;
    const b = await prisma.business.update({
      where: { id: req.params.id },
      data: { verified: !!verified },
    });
    res.json(b);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
