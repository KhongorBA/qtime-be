import express from 'express';
import { prisma } from '../config/db.js';
import { optionalAuth } from '../middleware/auth.js';

export const searchRoutes = express.Router();

searchRoutes.get('/', optionalAuth, async (req, res) => {
  try {
    const { q, city, category, lat, lng, radius = 50, page = 1, limit = 20 } = req.query;

    const where = { status: 'approved' };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } }
      ];
    }
    if (city) where.addressCity = { contains: city, mode: 'insensitive' };
    if (category) where.category = { contains: category, mode: 'insensitive' };

    if (lat && lng) {
      const latNum = Number(lat);
      const lngNum = Number(lng);
      const radiusKm = Number(radius);
      const latDelta = radiusKm / 111;
      const lngDelta = radiusKm / (111 * Math.cos((latNum * Math.PI) / 180));
      where.latitude = { gte: latNum - latDelta, lte: latNum + latDelta };
      where.longitude = { gte: lngNum - lngDelta, lte: lngNum + lngDelta };
    }

    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        where,
        include: { owner: { select: { name: true } } },
        orderBy: [{ rating: 'desc' }, { reviewCount: 'desc' }],
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit)
      }),
      prisma.business.count({ where })
    ]);

    res.json({ businesses, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
