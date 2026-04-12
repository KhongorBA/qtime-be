import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';
import { signJwt } from '../utils/jwtHelper.js';
import { sendBookingStatusEmail } from '../utils/emailService.js';

export const businessOwnerRoutes = express.Router();
businessOwnerRoutes.use(protect);

/** requireBusinessPartner - owner/manager/staff/admin */
const requireBusinessPartner = (req, res, next) => {
  if (!['business_owner', 'manager', 'staff', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'Бизнес аппын эрх шаардлагатай' });
  }
  next();
};

/** owner of business */
async function ensureOwner(req, res, businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { ownerId: true },
  });
  if (!business) return { ok: false, status: 404, message: 'Business not found' };
  if (business.ownerId !== req.user.id && req.user.role !== 'admin') {
    return { ok: false, status: 403, message: 'Not authorized' };
  }
  return { ok: true };
}

// GET /api/business-owner/my - Миний бизнесүүд
businessOwnerRoutes.get('/my', requireBusinessPartner, async (req, res) => {
  try {
    const businesses = await prisma.business.findMany({
      where: {
        OR: [
          { ownerId: req.user.id },
          { members: { some: { userId: req.user.id, status: 'approved' } } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          where: { userId: req.user.id },
          select: { role: true, status: true }
        }
      }
    });
    res.json(businesses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/bookings - Захиалгууд
businessOwnerRoutes.get('/:businessId/bookings', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { status, date, customerId } = req.query;
    const where = { businessId: req.params.businessId };
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (date) {
      const d = new Date(date);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      where.startTime = { gte: d, lt: nextDay };
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        staff: { select: { id: true, name: true } },
        business: { select: { images: true, services: true } },
        statusLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            changedBy: { select: { id: true, name: true, role: true } }
          }
        }
      },
      orderBy: { startTime: 'desc' },
    });

    // serviceImageUrl болон businessImageUrl нэмэх
    const enriched = bookings.map((b) => {
      const imgs = Array.isArray(b.business?.images) ? b.business.images : [];
      const services = Array.isArray(b.business?.services) ? b.business.services : [];
      const matched = services.find((s) => s.name === b.serviceName);
      return {
        ...b,
        businessImageUrl: imgs[0] || null,
        serviceImageUrl: matched?.imageUrl || matched?.image || null,
      };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/bookings/:id - Захиалгын статус өөрчлөх
businessOwnerRoutes.patch('/:businessId/bookings/:id', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
      select: { id: true, status: true, businessId: true },
    });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    const { status, staffId } = req.body;
    const allowedStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
    const data = {};
    if (status) {
      if (!allowedStatuses.includes(String(status))) {
        return res.status(400).json({ message: 'Invalid booking status' });
      }
      data.status = String(status);
    }
    if (staffId !== undefined) data.staffId = staffId || null;

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        staff: { select: { id: true, name: true } },
        statusLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            changedBy: { select: { id: true, name: true, role: true } }
          }
        }
      },
    });

    if (data.status && data.status !== booking.status) {
      const log = await prisma.bookingStatusLog.create({
        data: {
          bookingId: booking.id,
          oldStatus: booking.status,
          newStatus: data.status,
          changedById: req.user.id,
          note: 'Updated by owner/admin panel',
        },
      });
      updated.statusLogs = [
        {
          ...log,
          changedBy: { id: req.user.id, name: req.user.name, role: req.user.role },
        },
        ...updated.statusLogs,
      ];
    }

    if (data.status && ['confirmed', 'cancelled', 'completed'].includes(data.status)) {
      // Email мэдэгдэл (хэрэглэгчийн email байвал)
      const customerWithEmail = await prisma.user.findUnique({
        where: { id: updated.customerId },
        select: { email: true, name: true },
      });
      const businessForEmail = await prisma.business.findUnique({
        where: { id: updated.businessId },
        select: { name: true },
      });
      if (customerWithEmail?.email) {
        sendBookingStatusEmail({
          to: customerWithEmail.email,
          customerName: customerWithEmail.name || 'Хэрэглэгч',
          businessName: businessForEmail?.name || '',
          serviceName: updated.serviceName,
          startTime: updated.startTime,
          status: data.status,
          bookingId: updated.id,
        }).catch((e) => console.error('[EMAIL] booking status:', e.message));
      }

      const titleByStatus = {
        confirmed: 'Захиалга баталгаажлаа',
        cancelled: 'Захиалга цуцлагдлаа',
        completed: 'Захиалга амжилттай дууслаа',
      };
      const bodyByStatus = {
        confirmed: `${updated.serviceName} үйлчилгээний захиалга баталгаажсан.`,
        cancelled: `${updated.serviceName} үйлчилгээний захиалга цуцлагдсан.`,
        completed: `${updated.serviceName} үйлчилгээ амжилттай дууссан.`,
      };
      const notif = await prisma.notification.create({
        data: {
          userId: updated.customerId,
          title: titleByStatus[data.status],
          body: bodyByStatus[data.status],
          data: {
            type: 'booking_status',
            bookingId: updated.id,
            businessId: updated.businessId,
            status: data.status,
          },
        },
      });

      const devices = await prisma.userDevice.findMany({
        where: { userId: updated.customerId },
        select: { fcmToken: true, fcmApp: true },
      });
      await Promise.all(
        devices.map((dev) => {
          if (!dev.fcmToken) return Promise.resolve();
          return sendFcmMessage(
            dev.fcmToken,
            { title: titleByStatus[data.status], body: bodyByStatus[data.status] },
            {
              id: notif.id,
              type: 'booking_status',
              bookingId: updated.id,
              status: data.status,
            },
            dev.fcmApp === 'business' ? 'business' : 'consumer',
          );
        }),
      );
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/staff - Staff жагсаалт
businessOwnerRoutes.get('/:businessId/staff', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    // Prisma schema-д nickname/position байгаа ч DB-д миграци хийгээгүй үед findMany алдаатай байж болно.
    // Зөвхөн одоо байгаа багануудыг raw SELECT-ээр авна (шүүлтийн ажилтны жагсаалт гэх мэт).
    const staff = await prisma.$queryRaw`
      SELECT id, "businessId", name, phone, email, role, "createdAt", "updatedAt"
      FROM "Staff"
      WHERE "businessId" = ${req.params.businessId}
      ORDER BY "createdAt" ASC
    `;
    res.json(staff);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/business-owner/:businessId/staff - Staff нэмэх
businessOwnerRoutes.post(
  '/:businessId/staff',
  requireBusinessPartner,
  [
    body('name').trim().notEmpty().withMessage('name required'),
    body('phone').optional().trim(),
    body('email').optional().trim().isEmail(),
    body('role').optional().trim(),
    body('nickname').optional().trim(),
    body('position').optional().trim(),
  ],
  async (req, res) => {
    try {
      const check = await ensureOwner(req, res, req.params.businessId);
      if (!check.ok) return res.status(check.status).json({ message: check.message });

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const staff = await prisma.staff.create({
        data: {
          businessId: req.params.businessId,
          name: req.body.name.trim(),
          phone: req.body.phone?.trim() || null,
          email: req.body.email?.trim() || null,
          nickname: req.body.nickname?.trim() || null,
          position: req.body.position?.trim() || null,
          role: req.body.role?.trim() || null,
          avatar: req.body.avatar?.trim() || null,
          bio: req.body.bio?.trim() || null,
          serviceIndexes: req.body.serviceIndexes ?? null,
        },
      });
      res.status(201).json(staff);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// GET /api/business-owner/:businessId/staff/:staffId/schedule — ажилтны цагийн хуваарь
businessOwnerRoutes.get('/:businessId/staff/:staffId/schedule', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const staff = await prisma.staff.findFirst({
      where: { id: req.params.staffId, businessId: req.params.businessId },
      select: { openingHours: true, name: true },
    });
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    let hours = staff.openingHours;
    if (!Array.isArray(hours) || hours.length === 0) {
      const business = await prisma.business.findUnique({
        where: { id: req.params.businessId },
        select: { openingHours: true },
      });
      hours = Array.isArray(business?.openingHours) ? business.openingHours : [];
    }

    res.json({ openingHours: hours, staffName: staff.name });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/staff/:staffId/schedule
businessOwnerRoutes.patch('/:businessId/staff/:staffId/schedule', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const existing = await prisma.staff.findFirst({
      where: { id: req.params.staffId, businessId: req.params.businessId },
    });
    if (!existing) return res.status(404).json({ message: 'Staff not found' });

    const { openingHours } = req.body;
    if (!Array.isArray(openingHours)) {
      return res.status(400).json({ message: 'openingHours array required' });
    }

    const updated = await prisma.staff.update({
      where: { id: req.params.staffId },
      data: { openingHours },
    });
    res.json({ openingHours: updated.openingHours });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/staff/:staffId
businessOwnerRoutes.patch('/:businessId/staff/:staffId', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const existing = await prisma.staff.findFirst({
      where: { id: req.params.staffId, businessId: req.params.businessId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: 'Staff not found' });

    const { name, phone, email, role, nickname, position, avatar, bio, serviceIndexes } = req.body;
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (phone !== undefined) data.phone = phone?.trim() || null;
    if (email !== undefined) data.email = email?.trim() || null;
    if (role !== undefined) data.role = role?.trim() || null;
    if (nickname !== undefined) data.nickname = nickname?.trim() || null;
    if (position !== undefined) data.position = position?.trim() || null;
    if (avatar !== undefined) data.avatar = avatar?.trim() || null;
    if (bio !== undefined) data.bio = bio?.trim() || null;
    if (serviceIndexes !== undefined) data.serviceIndexes = serviceIndexes;

    const updated = await prisma.staff.update({
      where: { id: req.params.staffId },
      data,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/business-owner/:businessId/staff/:staffId
businessOwnerRoutes.delete('/:businessId/staff/:staffId', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const existing = await prisma.staff.findFirst({
      where: { id: req.params.staffId, businessId: req.params.businessId },
    });
    if (!existing) return res.status(404).json({ message: 'Staff not found' });

    await prisma.staff.delete({ where: { id: req.params.staffId } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/staff-performance — ажилтан бүрийн гүйцэтгэл
businessOwnerRoutes.get('/:businessId/staff-performance', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { from, to } = req.query;
    const where = {
      businessId: req.params.businessId,
      status: { in: ['confirmed', 'completed'] },
    };
    if (from) where.startTime = { ...where.startTime, gte: new Date(from) };
    if (to) {
      const toEnd = new Date(to);
      toEnd.setHours(23, 59, 59, 999);
      where.startTime = { ...where.startTime, lte: toEnd };
    }

    const bookings = await prisma.booking.findMany({
      where,
      select: {
        servicePrice: true,
        status: true,
        serviceName: true,
        startTime: true,
        staffId: true,
        staff: { select: { id: true, name: true, role: true } },
      },
    });

    // Aggregate per staff
    const map = new Map();
    for (const b of bookings) {
      const key = b.staffId || '__none__';
      const name = b.staff?.name || 'Ажилтангүй';
      const role = b.staff?.role || '';
      if (!map.has(key)) {
        map.set(key, { staffId: key === '__none__' ? null : key, name, role, bookings: 0, revenue: 0, services: {} });
      }
      const entry = map.get(key);
      entry.bookings += 1;
      entry.revenue += b.servicePrice || 0;
      entry.services[b.serviceName] = (entry.services[b.serviceName] || 0) + 1;
    }

    const results = Array.from(map.values())
      .map((e) => ({
        ...e,
        revenue: Math.round(e.revenue * 100) / 100,
        topService: Object.entries(e.services).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({ items: results, totalBookings: bookings.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/income - Орлого
businessOwnerRoutes.get('/:businessId/income', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { from, to, staffId, serviceName } = req.query;
    const where = {
      businessId: req.params.businessId,
      status: { in: ['confirmed', 'completed'] },
    };
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setHours(23, 59, 59, 999);
      where.startTime = { gte: new Date(from), lte: toEnd };
    } else if (from) {
      where.startTime = { gte: new Date(from) };
    } else if (to) {
      const toEnd = new Date(to);
      toEnd.setHours(23, 59, 59, 999);
      where.startTime = { lte: toEnd };
    }
    if (staffId) where.staffId = String(staffId);
    if (serviceName && String(serviceName).trim()) {
      where.serviceName = String(serviceName).trim();
    }

    const bookings = await prisma.booking.findMany({
      where,
      select: {
        id: true,
        servicePrice: true,
        startTime: true,
        status: true,
        serviceName: true,
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        staff: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    const total = bookings.reduce((sum, b) => sum + (b.servicePrice || 0), 0);
    const byMonth = {};
    for (const b of bookings) {
      const key = `${b.startTime.getFullYear()}-${String(b.startTime.getMonth() + 1).padStart(2, '0')}`;
      byMonth[key] = (byMonth[key] || 0) + (b.servicePrice || 0);
    }

    res.json({
      total: Math.round(total * 100) / 100,
      count: bookings.length,
      byMonth,
      items: bookings.map((b) => ({
        id: b.id,
        startTime: b.startTime,
        status: b.status,
        serviceName: b.serviceName,
        servicePrice: b.servicePrice || 0,
        customer: {
          id: b.customer?.id,
          name: b.customer?.name || 'Unknown',
          phone: b.customer?.phone || null,
          email: b.customer?.email || null,
        },
        staff: b.staff
          ? { id: b.staff.id, name: b.staff.name || null }
          : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/schedule - Цагийн хуваарь (openingHours)
businessOwnerRoutes.get('/:businessId/schedule', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const business = await prisma.business.findUnique({
      where: { id: req.params.businessId },
      select: { openingHours: true, name: true },
    });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    res.json({
      openingHours: business.openingHours || [],
      businessName: business.name,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/schedule - Цагийн хуваарь шинэчлэх
businessOwnerRoutes.patch('/:businessId/schedule', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { openingHours } = req.body;
    if (!Array.isArray(openingHours)) {
      return res.status(400).json({ message: 'openingHours array required' });
    }

    const updated = await prisma.business.update({
      where: { id: req.params.businessId },
      data: { openingHours },
    });
    res.json({ openingHours: updated.openingHours });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/services - Үйлчилгээнүүд
businessOwnerRoutes.get('/:businessId/services', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const business = await prisma.business.findUnique({
      where: { id: req.params.businessId },
      select: { services: true },
    });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const services = Array.isArray(business.services) ? business.services : [];
    res.json(services);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/services - Үйлчилгээ нэмэх/засварлах
businessOwnerRoutes.patch('/:businessId/services', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { services } = req.body;
    if (!Array.isArray(services)) {
      return res.status(400).json({ message: 'services array required' });
    }

    const updated = await prisma.business.update({
      where: { id: req.params.businessId },
      data: { services },
    });
    res.json({ services: updated.services });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/join-requests - Owner pending requests
businessOwnerRoutes.get('/:businessId/join-requests', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const status = req.query.status ? String(req.query.status) : 'pending';
    const list = await prisma.businessMember.findMany({
      where: { businessId: req.params.businessId, status },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/business-owner/:businessId/join-requests/:requestId
businessOwnerRoutes.patch('/:businessId/join-requests/:requestId', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const nextStatus = String(req.body.status || '');
    if (!['approved', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({ message: 'status must be approved or rejected' });
    }

    const request = await prisma.businessMember.findFirst({
      where: { id: req.params.requestId, businessId: req.params.businessId }
    });
    if (!request) return res.status(404).json({ message: 'Request not found' });

    const updated = await prisma.businessMember.update({
      where: { id: request.id },
      data: {
        status: nextStatus,
        reviewedAt: new Date(),
        reviewedBy: req.user.id
      }
    });

    if (nextStatus === 'approved') {
      const mappedRole = updated.role === 'manager' ? 'manager' : 'staff';
      await prisma.user.update({
        where: { id: updated.userId },
        data: { role: mappedRole }
      });
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const normalizePhoneSearch = (v) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  let compact = raw.replace(/[\s\-()]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (compact.startsWith('+')) return compact;
  if (compact.startsWith('976') && compact.length >= 11) return `+${compact}`;
  if (/^\d{8}$/.test(compact)) return `+976${compact}`;
  return compact;
};

// GET /api/business-owner/:businessId/users/search?q= — утас / loginName / имэйлээр хайх
businessOwnerRoutes.get('/:businessId/users/search', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) {
      return res.json([]);
    }

    const phoneNorm = normalizePhoneSearch(raw);
    const users = await prisma.user.findMany({
      where: {
        NOT: { id: req.user.id },
        OR: [
          ...(phoneNorm.length >= 8 ? [{ phone: { contains: raw.replace(/\s/g, '') } }] : []),
          { loginName: { contains: raw, mode: 'insensitive' } },
          { email: { contains: raw, mode: 'insensitive' } },
          { name: { contains: raw, mode: 'insensitive' } },
        ],
      },
      take: 25,
      select: { id: true, name: true, phone: true, email: true, loginName: true },
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/business-owner/:businessId/invite-user — хэрэглэгчид бизнесэд нэгдэх урилга
businessOwnerRoutes.post(
  '/:businessId/invite-user',
  requireBusinessPartner,
  [
    body('userId').trim().notEmpty(),
    body('memberRole').isIn(['staff', 'manager']).withMessage('memberRole must be staff or manager'),
  ],
  async (req, res) => {
    try {
      const check = await ensureOwner(req, res, req.params.businessId);
      if (!check.ok) return res.status(check.status).json({ message: check.message });

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const business = await prisma.business.findUnique({
        where: { id: req.params.businessId },
        select: { id: true, name: true, ownerId: true, status: true },
      });
      if (!business || business.status !== 'approved') {
        return res.status(404).json({ message: 'Business not found' });
      }

      const target = await prisma.user.findUnique({
        where: { id: req.body.userId.trim() },
        select: { id: true, name: true },
      });
      if (!target) return res.status(404).json({ message: 'Хэрэглэгч олдсонгүй' });

      const memberRole = req.body.memberRole === 'manager' ? 'manager' : 'staff';

      const existing = await prisma.businessMember.findUnique({
        where: {
          businessId_userId: {
            businessId: business.id,
            userId: target.id,
          },
        },
      });
      if (existing?.status === 'approved') {
        return res.status(400).json({ message: 'Энэ хэрэглэгч аль хэдийн багтсан байна' });
      }
      if (existing?.status === 'pending') {
        return res.status(400).json({ message: 'Урилга аль хэдийн илгээгдсэн байна' });
      }

      let member;
      if (existing?.status === 'rejected') {
        member = await prisma.businessMember.update({
          where: { id: existing.id },
          data: {
            role: memberRole,
            status: 'pending',
            reviewedAt: null,
            reviewedBy: null,
          },
        });
      } else {
        member = await prisma.businessMember.create({
          data: {
            businessId: business.id,
            userId: target.id,
            role: memberRole,
            status: 'pending',
          },
        });
      }

      const notif = await prisma.notification.create({
        data: {
          userId: target.id,
          title: 'Бизнесийн урилга',
          body: `${business.name} танд ${memberRole === 'manager' ? 'менежер' : 'ажилтан'} эрхээр урилга илгээлээ.`,
          data: {
            type: 'business_invite',
            businessId: business.id,
            memberId: member.id,
            role: memberRole,
          },
        },
      });

      const devices = await prisma.userDevice.findMany({
        where: { userId: target.id },
        select: { fcmToken: true, fcmApp: true },
      });
      await Promise.all(
        devices.map((dev) => {
          if (!dev.fcmToken) return Promise.resolve();
          return sendFcmMessage(
            dev.fcmToken,
            { title: 'Бизнесийн урилга', body: `${business.name} — урилга ирлээ` },
            {
              id: notif.id,
              type: 'business_invite',
              businessId: business.id,
              memberId: member.id,
            },
            dev.fcmApp === 'business' ? 'business' : 'consumer',
          );
        }),
      );

      res.status(201).json(member);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /api/business-owner/:businessId/staff-invite-token — 6 оронтой урилгын код + QR
businessOwnerRoutes.post(
  '/:businessId/staff-invite-token',
  requireBusinessPartner,
  [body('memberRole').isIn(['staff', 'manager']).withMessage('memberRole must be staff or manager')],
  async (req, res) => {
    try {
      const check = await ensureOwner(req, res, req.params.businessId);
      if (!check.ok) return res.status(check.status).json({ message: check.message });

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const business = await prisma.business.findUnique({
        where: { id: req.params.businessId },
        select: { id: true, name: true, status: true },
      });
      if (!business || business.status !== 'approved') {
        return res.status(404).json({ message: 'Business not found' });
      }

      const memberRole = req.body.memberRole === 'manager' ? 'manager' : 'staff';
      const ttlMinutes = Number(req.body.ttlMinutes) || 30;

      // 6 оронтой код үүсгэх, давхцалгүй байх
      let code;
      let attempts = 0;
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
        const existing = await prisma.staffInviteCode.findUnique({ where: { code } });
        if (!existing) break;
        attempts++;
      } while (attempts < 10);

      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      await prisma.staffInviteCode.create({
        data: { businessId: business.id, code, memberRole, expiresAt },
      });

      res.json({
        code,
        businessId: business.id,
        businessName: business.name,
        memberRole,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// POST /api/business-owner/:businessId/resubmit-approval
// PATCH /api/business-owner/:businessId/availability — Online/offline switch
businessOwnerRoutes.patch('/:businessId/availability', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const { acceptingBookings } = req.body;
    if (typeof acceptingBookings !== 'boolean') {
      return res.status(400).json({ message: 'acceptingBookings boolean утга шаардлагатай' });
    }
    const updated = await prisma.business.update({
      where: { id: req.params.businessId },
      data: { acceptingBookings },
      select: { id: true, acceptingBookings: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/business-owner/:businessId/availability — одоогийн статус
businessOwnerRoutes.get('/:businessId/availability', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const biz = await prisma.business.findUnique({
      where: { id: req.params.businessId },
      select: { id: true, acceptingBookings: true },
    });
    if (!biz) return res.status(404).json({ message: 'Business not found' });
    res.json(biz);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

businessOwnerRoutes.post('/:businessId/resubmit-approval', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    const updated = await prisma.business.update({
      where: { id: req.params.businessId },
      data: { status: 'pending' }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Waiting List ────────────────────────────────────────────────────────────
// GET  /:businessId/waiting-list      — бүх хүлээлтийн жагсаалт
// POST /:businessId/waiting-list/:id/notify — хэрэглэгчид мэдэгдэл илгээх
// PATCH /:businessId/waiting-list/:id — статус өөрчлөх (notified|booked|cancelled)

businessOwnerRoutes.get('/:businessId/waiting-list', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    const { status } = req.query;
    const where = { businessId: req.params.businessId };
    if (status) where.status = status;
    const list = await prisma.waitingList.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

businessOwnerRoutes.patch('/:businessId/waiting-list/:id', requireBusinessPartner, async (req, res) => {
  try {
    const check = await ensureOwner(req, res, req.params.businessId);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    const { status } = req.body;
    const allowed = ['waiting', 'notified', 'booked', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const updated = await prisma.waitingList.update({
      where: { id: req.params.id },
      data: { status, ...(status === 'notified' ? { notifiedAt: new Date() } : {}) },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
