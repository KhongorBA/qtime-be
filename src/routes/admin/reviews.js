import express from 'express';
import { prisma } from '../../config/db.js';

export const reviewsRouter = express.Router();

// GET /api/admin/reviews - review хянах
reviewsRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, rating } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const where = rating ? { rating: parseInt(rating, 10) } : {};

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, email: true } },
          business: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit, 10),
      }),
      prisma.review.count({ where }),
    ]);

    res.json({ reviews, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/admin/reviews/:id - review устгах
reviewsRouter.delete('/:id', async (req, res) => {
  try {
    await prisma.review.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
