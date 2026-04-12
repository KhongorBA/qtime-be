import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/requireSubscription.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

export const bookingRoutes = express.Router();

bookingRoutes.use(protect);

const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const parseHm = (value) => {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { hour, minute };
};

const combineDateAndHm = (dateStr, hm) => {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, hm.hour, hm.minute, 0, 0);
};

/** Өдрийн мөр: нэрээр, JS getDay (create_business), эсвэл хуучин Даваа=0…Ням=6 (schedule) */
const resolveDayHours = (openingHours, jsDow) => {
  const dayName = dayNames[jsDow];
  const mondayFirstDow = (jsDow + 6) % 7;
  const byName = openingHours.find(
    (d) => typeof d?.day === 'string' && String(d.day).toLowerCase() === dayName
  );
  if (byName) return byName;
  const byJs = openingHours.find((d) => Number(d?.day) === jsDow);
  if (byJs) return byJs;
  return openingHours.find((d) => Number(d?.day) === mondayFirstDow) || null;
};

const rangesOverlap = (a0, a1, b0, b1) => a0 < b1 && a1 > b0;

bookingRoutes.get('/availability', async (req, res) => {
  try {
    const { businessId, date, serviceIndex = 0, staffId } = req.query;
    if (!businessId || !date) {
      return res.status(400).json({ message: 'businessId and date are required' });
    }
    const business = await prisma.business.findUnique({
      where: { id: String(businessId) },
      select: { id: true, services: true, openingHours: true, status: true }
    });
    if (!business || business.status !== 'approved') {
      return res.status(404).json({ message: 'Business not found' });
    }

    let selectedStaffId = null;
    if (staffId && String(staffId).trim()) {
      const staff = await prisma.staff.findFirst({
        where: { id: String(staffId).trim(), businessId: String(businessId) },
        select: { id: true },
      });
      if (!staff) {
        return res.status(400).json({ message: 'Invalid staffId' });
      }
      selectedStaffId = staff.id;
    }

    const services = Array.isArray(business.services) ? business.services : [];
    const idx = Number(serviceIndex);
    const service = services[idx];
    if (!service) return res.status(400).json({ message: 'Invalid serviceIndex' });

    const duration = Number(service.duration || 60);
    const openingHours = Array.isArray(business.openingHours) ? business.openingHours : [];

    const dateObj = new Date(`${date}T12:00:00`);
    if (Number.isNaN(dateObj.getTime())) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }
    const jsDow = dateObj.getDay();
    const dayHours = resolveDayHours(openingHours, jsDow);

    if (!dayHours || dayHours.closed === true) {
      return res.json({ businessId, date, serviceIndex: idx, duration, slots: [] });
    }

    const openHm = parseHm(dayHours.open);
    const closeHm = parseHm(dayHours.close);
    if (!openHm || !closeHm) {
      return res.json({ businessId, date, serviceIndex: idx, duration, slots: [] });
    }

    const lunchStartHm = parseHm(dayHours.lunchStart);
    const lunchEndHm = parseHm(dayHours.lunchEnd);

    const dayStart = combineDateAndHm(String(date), openHm);
    const dayEnd = combineDateAndHm(String(date), closeHm);
    if (dayEnd <= dayStart) {
      return res.json({ businessId, date, serviceIndex: idx, duration, slots: [] });
    }

    let lunchStart = null;
    let lunchEnd = null;
    if (lunchStartHm && lunchEndHm) {
      lunchStart = combineDateAndHm(String(date), lunchStartHm);
      lunchEnd = combineDateAndHm(String(date), lunchEndHm);
      if (lunchEnd <= lunchStart) {
        lunchStart = null;
        lunchEnd = null;
      }
    }

    /** Идэвхтэй захиалга (давхцах шалгах): зөвхөн pending + confirmed — дууссан/цуцлагдсан цагийг дахин нээх */
    const bookings = await prisma.booking.findMany({
      where: {
        businessId: String(businessId),
        ...(selectedStaffId ? { staffId: selectedStaffId } : {}),
        status: { in: ['pending', 'confirmed'] },
        startTime: { lt: dayEnd },
        endTime: { gt: dayStart }
      },
      select: { startTime: true, endTime: true, staffId: true }
    });

    let businessStaffIds = [];
    if (!selectedStaffId) {
      const staff = await prisma.staff.findMany({
        where: { businessId: String(businessId) },
        select: { id: true },
      });
      businessStaffIds = staff.map((s) => s.id);
    }

    const rawInterval = Number(service.slotIntervalMinutes);
    const intervalMinutes = Math.min(120, Math.max(5, Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 30));

    const nowMs = Date.now();
    const slots = [];
    const allSlots = [];
    for (
      let cursor = new Date(dayStart);
      cursor.getTime() + duration * 60000 <= dayEnd.getTime();
      cursor = new Date(cursor.getTime() + intervalMinutes * 60000)
    ) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor.getTime() + duration * 60000);
      const inLunch =
        lunchStart &&
        lunchEnd &&
        rangesOverlap(slotStart.getTime(), slotEnd.getTime(), lunchStart.getTime(), lunchEnd.getTime());
      if (inLunch || slotStart.getTime() <= nowMs) {
        continue;
      }

      allSlots.push(slotStart.toISOString());

      let available = false;
      if (selectedStaffId) {
        const conflict = bookings.some(
          (b) => b.startTime < slotEnd && b.endTime > slotStart,
        );
        available = !conflict;
      } else if (businessStaffIds.length > 0) {
        // "Дурын" үед зөвхөн бүх ажилтан хоосон байгаа цагийг идэвхтэй болгоно.
        const unassignedConflict = bookings.some(
          (b) => !b.staffId && b.startTime < slotEnd && b.endTime > slotStart,
        );
        available =
          !unassignedConflict &&
          businessStaffIds.every((sid) => {
            const conflict = bookings.some(
              (b) => b.staffId === sid && b.startTime < slotEnd && b.endTime > slotStart,
            );
            return !conflict;
          });
      } else {
        const conflict = bookings.some(
          (b) => b.startTime < slotEnd && b.endTime > slotStart,
        );
        available = !conflict;
      }

      if (available) {
        slots.push(slotStart.toISOString());
      }
    }

    res.json({
      businessId,
      date,
      serviceIndex: idx,
      duration,
      staffId: selectedStaffId,
      slotIntervalMinutes: intervalMinutes,
      allSlots,
      slots,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

bookingRoutes.post(
  '/',
  [
    body('businessId').trim().notEmpty(),
    body('serviceIndex').isInt({ min: 0 }),
    body('startTime').isISO8601(),
    body('staffId').optional().trim().notEmpty(),
    body('recurringIntervalDays').optional().isInt({ min: 1, max: 365 }),
    body('recurringCount').optional().isInt({ min: 1, max: 52 }),
  ],
  requireActiveSubscription,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { businessId, serviceIndex, startTime, notes, staffId, recurringIntervalDays, recurringCount } = req.body;
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (!business) return res.status(404).json({ message: 'Business not found' });

      const services = Array.isArray(business.services) ? business.services : [];
      const service = services[serviceIndex];
      if (!service) return res.status(400).json({ message: 'Invalid service' });

      let selectedStaffId = null;
      if (staffId && String(staffId).trim()) {
        const staff = await prisma.staff.findFirst({
          where: { id: String(staffId).trim(), businessId },
          select: { id: true },
        });
        if (!staff) return res.status(400).json({ message: 'Invalid staffId' });
        selectedStaffId = staff.id;
      }

      const start = new Date(startTime);
      const duration = service.duration || 60;
      const end = new Date(start.getTime() + duration * 60000);

      const conflict = await prisma.booking.findFirst({
        where: {
          businessId,
          ...(selectedStaffId ? { staffId: selectedStaffId } : {}),
          status: { in: ['pending', 'confirmed'] },
          OR: [{ startTime: { lt: end }, endTime: { gt: start } }],
        },
      });
      if (conflict) return res.status(400).json({ message: 'Time slot not available' });

      const intervalDays = recurringIntervalDays ? Number(recurringIntervalDays) : null;
      const repeatCount = recurringCount ? Math.min(Number(recurringCount), 52) : 0;

      const booking = await prisma.booking.create({
        data: {
          customerId: req.user.id,
          businessId,
          staffId: selectedStaffId,
          serviceName: service.name,
          serviceDuration: duration,
          servicePrice: service.price ?? 0,
          startTime: start,
          endTime: end,
          status: 'pending',
          notes,
          recurringIntervalDays: intervalDays,
        },
        include: { business: { select: { id: true, name: true, addressCity: true, addressStreet: true, images: true, rating: true } } }
      });

      // Create recurring child bookings (best-effort, skip conflicting slots)
      if (intervalDays && repeatCount > 0) {
        for (let i = 1; i <= repeatCount; i++) {
          const childStart = new Date(start.getTime() + i * intervalDays * 24 * 60 * 60 * 1000);
          const childEnd = new Date(childStart.getTime() + duration * 60000);
          const childConflict = await prisma.booking.findFirst({
            where: {
              businessId,
              ...(selectedStaffId ? { staffId: selectedStaffId } : {}),
              status: { in: ['pending', 'confirmed'] },
              OR: [{ startTime: { lt: childEnd }, endTime: { gt: childStart } }],
            },
          });
          if (!childConflict) {
            await prisma.booking.create({
              data: {
                customerId: req.user.id,
                businessId,
                staffId: selectedStaffId,
                serviceName: service.name,
                serviceDuration: duration,
                servicePrice: service.price ?? 0,
                startTime: childStart,
                endTime: childEnd,
                status: 'pending',
                notes,
                recurringIntervalDays: intervalDays,
                recurringParentId: booking.id,
              },
            });
          }
        }
      }

      const customerName = (req.user?.name && String(req.user.name).trim()) || 'Хэрэглэгч';
      const pad = (n) => String(n).padStart(2, '0');
      const timeLine = `${pad(start.getHours())}:${pad(start.getMinutes())} — ${pad(start.getDate())}/${pad(start.getMonth() + 1)}`;
      const notifyTitle = 'Шинэ захиалга';
      const notifyBody = `${customerName} — ${service.name} • ${timeLine}`;

      const recipientIds = new Set();
      recipientIds.add(business.ownerId);
      const partners = await prisma.businessMember.findMany({
        where: {
          businessId,
          status: 'approved',
          role: { in: ['owner', 'manager'] },
        },
        select: { userId: true },
      });
      for (const p of partners) {
        recipientIds.add(p.userId);
      }
      recipientIds.delete(req.user.id);

      for (const userId of recipientIds) {
        let notif;
        try {
          notif = await prisma.notification.create({
            data: {
              userId,
              title: notifyTitle,
              body: notifyBody,
              data: {
                type: 'booking',
                bookingId: booking.id,
                businessId,
                status: 'pending',
                startTime: start.toISOString(),
              },
            },
          });
        } catch (e) {
          console.error('[booking] notify business partner:', e);
          continue;
        }
        const devices = await prisma.userDevice.findMany({
          where: { userId },
          select: { fcmToken: true, fcmApp: true },
        });
        await Promise.all(
          devices.map((dev) => {
            if (!dev.fcmToken) return Promise.resolve();
            return sendFcmMessage(
              dev.fcmToken,
              { title: notifyTitle, body: notifyBody },
              {
                id: notif.id,
                type: 'booking',
                bookingId: booking.id,
                businessId,
                status: 'pending',
                startTime: start.toISOString(),
              },
              dev.fcmApp === 'business' ? 'business' : 'consumer',
            );
          }),
        );
      }

      res.status(201).json(booking);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

bookingRoutes.get('/me', async (req, res) => {
  try {
    const { status, upcoming } = req.query;
    const where = { customerId: req.user.id };
    if (status) where.status = status;
    if (upcoming === 'true') {
      where.startTime = { gte: new Date() };
      where.status = { notIn: ['cancelled', 'owner_timeout'] };
    }
    const bookings = await prisma.booking.findMany({
      where,
      include: {
        business: { select: { id: true, name: true, addressCity: true, addressStreet: true, images: true, rating: true, services: true } },
        payment: {
          select: {
            depositAmount: true,
            remainderAmount: true,
            depositCapturedAt: true,
            remainderCapturedAt: true,
            remainderIntentId: true,
            status: true,
          },
        },
        statusLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            changedBy: { select: { id: true, name: true, role: true } }
          }
        }
      },
      orderBy: { startTime: 'desc' }
    });

    // serviceImageUrl — үйлчилгээний зураг
    const enriched = bookings.map((b) => {
      const services = Array.isArray(b.business?.services) ? b.business.services : [];
      const matched = services.find((s) => s.name === b.serviceName);
      return { ...b, serviceImageUrl: matched?.imageUrl || matched?.image || null };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

bookingRoutes.patch('/:id/cancel', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.customerId !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' }
    });

    if (booking.status !== 'cancelled') {
      await prisma.bookingStatusLog.create({
        data: {
          bookingId: booking.id,
          oldStatus: booking.status,
          newStatus: 'cancelled',
          changedById: req.user.id,
          note: 'Cancelled by customer',
        },
      });
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/bookings/waiting-list — Хүлээлтийн жагсаалтад нэмэгдэх
bookingRoutes.post('/waiting-list', async (req, res) => {
  try {
    const { businessId, serviceIndex, preferredDate, notes } = req.body;
    if (!businessId) return res.status(400).json({ message: 'businessId шаардлагатай' });
    const entry = await prisma.waitingList.create({
      data: {
        businessId,
        customerId: req.user.id,
        serviceIndex: serviceIndex ?? 0,
        preferredDate: preferredDate ? new Date(preferredDate) : null,
        notes: notes || null,
      },
      include: { customer: { select: { id: true, name: true } } },
    });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/bookings/waiting-list/:id — Хүлээлтийн жагсаалтаас хасах
bookingRoutes.delete('/waiting-list/:id', async (req, res) => {
  try {
    const entry = await prisma.waitingList.findFirst({
      where: { id: req.params.id, customerId: req.user.id },
    });
    if (!entry) return res.status(404).json({ message: 'Олдсонгүй' });
    await prisma.waitingList.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
