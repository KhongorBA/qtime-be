import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';

export const reviewRoutes = express.Router();

reviewRoutes.use(protect);

reviewRoutes.get('/my', async (req, res) => {
  try {
    const businessId = String(req.query.businessId || '').trim();
    if (!businessId) {
      return res.status(400).json({ message: 'businessId is required' });
    }
    const existing = await prisma.review.findUnique({
      where: {
        customerId_businessId: { customerId: req.user.id, businessId }
      },
      select: { id: true }
    });
    return res.json({ reviewed: Boolean(existing) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

reviewRoutes.post(
  '/',
  [
    body('businessId').trim().notEmpty(),
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().trim()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { businessId, rating, comment } = req.body;
      const existing = await prisma.review.findUnique({
        where: {
          customerId_businessId: { customerId: req.user.id, businessId }
        }
      });
      if (existing) return res.status(400).json({ message: 'You have already reviewed this business' });

      const review = await prisma.review.create({
        data: {
          customerId: req.user.id,
          businessId,
          rating: Number(rating),
          comment: comment || null
        },
        include: { customer: { select: { name: true } } }
      });

      const reviews = await prisma.review.findMany({ where: { businessId } });
      const avg = reviews.reduce((a, r) => a + r.rating, 0) / reviews.length;
      await prisma.business.update({
        where: { id: businessId },
        data: {
          rating: Math.round(avg * 10) / 10,
          reviewCount: reviews.length
        }
      });

      res.status(201).json(review);
    } catch (err) {
      if (err.code === 'P2003') return res.status(404).json({ message: 'Business not found' });
      res.status(500).json({ message: err.message });
    }
  }
);
