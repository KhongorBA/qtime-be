import express from 'express';
import { prisma } from '../../config/db.js';

export const paymentsRouter = express.Router();

// GET /api/admin/payments - payment шалгах (bookings-аас servicePrice)
paymentsRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const where = { status: { not: 'cancelled' } };
    const [bookings, total, revenueTotal] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, email: true } },
          business: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit, 10),
      }),
      prisma.booking.count({ where }),
      prisma.booking.aggregate({
        where,
        _sum: { servicePrice: true },
      }),
    ]);

    const payments = bookings.map((b) => ({
      id: b.id,
      amount: b.servicePrice,
      status: b.status,
      customer: b.customer,
      business: b.business,
      startTime: b.startTime,
      serviceName: b.serviceName,
      createdAt: b.createdAt,
    }));

    res.json({
      payments,
      total,
      revenueTotal: revenueTotal._sum.servicePrice ?? 0,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
