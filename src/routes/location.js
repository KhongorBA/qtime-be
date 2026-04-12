import express from 'express';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
export const locationRoutes = router;

// ─── Business-owner: manage their own locations ───────────────────────────────

// GET /locations/business/:businessId — list all locations for a business
router.get('/business/:businessId', protect, async (req, res) => {
  const { businessId } = req.params;
  try {
    const business = await prisma.business.findFirst({
      where: { id: businessId, ownerId: req.user.id },
      select: { id: true },
    });
    if (!business) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });

    const locations = await prisma.businessLocation.findMany({
      where: { businessId },
      orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
    });
    res.json(locations);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /locations/business/:businessId — add a location
router.post('/business/:businessId', protect, async (req, res) => {
  const { businessId } = req.params;
  const { name, addressStreet, addressCity, latitude, longitude, phone, isMain } = req.body;
  if (!name || !addressCity) {
    return res.status(400).json({ message: 'Нэр болон хот заавал оруулна уу' });
  }
  try {
    const business = await prisma.business.findFirst({
      where: { id: businessId, ownerId: req.user.id },
      select: { id: true },
    });
    if (!business) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });

    // If new location is main, unset all others
    if (isMain) {
      await prisma.businessLocation.updateMany({
        where: { businessId },
        data: { isMain: false },
      });
    }

    const location = await prisma.businessLocation.create({
      data: { businessId, name, addressStreet, addressCity, latitude, longitude, phone, isMain: !!isMain },
    });
    res.status(201).json(location);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PATCH /locations/:id — update a location
router.patch('/:id', protect, async (req, res) => {
  const { id } = req.params;
  const { name, addressStreet, addressCity, latitude, longitude, phone, isMain } = req.body;
  try {
    const loc = await prisma.businessLocation.findUnique({ where: { id }, include: { business: { select: { ownerId: true } } } });
    if (!loc) return res.status(404).json({ message: 'Байршил олдсонгүй' });
    if (loc.business.ownerId !== req.user.id) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });

    if (isMain) {
      await prisma.businessLocation.updateMany({
        where: { businessId: loc.businessId },
        data: { isMain: false },
      });
    }

    const updated = await prisma.businessLocation.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(addressStreet !== undefined && { addressStreet }),
        ...(addressCity !== undefined && { addressCity }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(phone !== undefined && { phone }),
        ...(isMain !== undefined && { isMain }),
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /locations/:id
router.delete('/:id', protect, async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await prisma.businessLocation.findUnique({ where: { id }, include: { business: { select: { ownerId: true } } } });
    if (!loc) return res.status(404).json({ message: 'Байршил олдсонгүй' });
    if (loc.business.ownerId !== req.user.id) return res.status(403).json({ message: 'Зөвшөөрөл байхгүй' });

    await prisma.businessLocation.delete({ where: { id } });
    res.json({ message: 'Устгагдлаа' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── Public: get locations for a business ────────────────────────────────────
router.get('/public/:businessId', async (req, res) => {
  const { businessId } = req.params;
  try {
    const locations = await prisma.businessLocation.findMany({
      where: { businessId },
      orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
    });
    res.json(locations);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
