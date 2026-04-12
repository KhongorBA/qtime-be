import express from 'express';
import { prisma } from '../../config/db.js';

export const analyticsRouter = express.Router();

// GET /api/admin/analytics - report / analytics
analyticsRouter.get('/', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [userCount, businessCount, bookingCount, reviewCount, bookingsThisMonth, revenueThisMonth] = await Promise.all([
      prisma.user.count(),
      prisma.business.count(),
      prisma.booking.count(),
      prisma.review.count(),
      prisma.booking.count({
        where: {
          createdAt: { gte: startOfMonth },
          status: { not: 'cancelled' },
        },
      }),
      prisma.booking.aggregate({
        where: {
          createdAt: { gte: startOfMonth },
          status: { not: 'cancelled' },
        },
        _sum: { servicePrice: true },
      }),
    ]);

    const stats = {
      users: userCount,
      businesses: businessCount,
      bookings: bookingCount,
      reviews: reviewCount,
      bookingsThisMonth,
      revenueThisMonth: revenueThisMonth._sum.servicePrice ?? 0,
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/analytics/charts — сүүлийн 6 сарын chart өгөгдөл
analyticsRouter.get('/charts', async (req, res) => {
  try {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        year: d.getFullYear(),
        month: d.getMonth(),
        label: d.toLocaleString('mn-MN', { month: 'short', year: 'numeric' }),
        from: new Date(d.getFullYear(), d.getMonth(), 1),
        to: new Date(d.getFullYear(), d.getMonth() + 1, 1),
      });
    }

    const chartData = await Promise.all(
      months.map(async ({ label, from, to }) => {
        const [bookings, revenue, newUsers] = await Promise.all([
          prisma.booking.count({
            where: { createdAt: { gte: from, lt: to }, status: { not: 'cancelled' } },
          }),
          prisma.booking.aggregate({
            where: { createdAt: { gte: from, lt: to }, status: { not: 'cancelled' } },
            _sum: { servicePrice: true },
          }),
          prisma.user.count({ where: { createdAt: { gte: from, lt: to } } }),
        ]);
        return {
          month: label,
          bookings,
          revenue: revenue._sum.servicePrice ?? 0,
          newUsers,
        };
      }),
    );

    res.json(chartData);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
