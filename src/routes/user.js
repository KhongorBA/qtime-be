import express from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { verifyJwt } from '../utils/jwtHelper.js';

export const userRoutes = express.Router();

userRoutes.use(protect);

const normalizeEmail = (v) => String(v || '').trim().toLowerCase();
const generateOtpCode = () => String(Math.floor(100000 + Math.random() * 900000));
const PURPOSE_PROFILE_EMAIL = 'profile_email';
const OTP_EXPIRES_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;

userRoutes.get('/profile', (req, res) => res.json(req.user));

userRoutes.patch(
  '/profile',
  [
    body('name').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('avatar').optional().isURL(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const data = {};
      if (req.body.name !== undefined) data.name = String(req.body.name).trim();
      if (req.body.phone !== undefined) data.phone = req.body.phone?.trim() || null;
      if (req.body.avatar !== undefined) data.avatar = req.body.avatar;
      const user = await prisma.user.update({
        where: { id: req.user.id },
        data,
        select: { id: true, name: true, email: true, role: true, phone: true, avatar: true },
      });
      res.json(user);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

/** Шинэ имэйл рүү OTP илгээх (имэйл солих) */
userRoutes.post(
  '/profile/request-email-change',
  [body('newEmail').trim().isEmail().withMessage('Зөв имэйл оруулна уу')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const newEmail = normalizeEmail(req.body.newEmail);
      const current = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true },
      });
      if (!current) return res.status(404).json({ message: 'User not found' });
      if (normalizeEmail(current.email) === newEmail) {
        return res.status(400).json({ message: 'Өөр имэйл оруулна уу' });
      }

      const taken = await prisma.user.findFirst({
        where: {
          email: { equals: newEmail, mode: 'insensitive' },
          NOT: { id: req.user.id },
        },
      });
      if (taken) {
        return res.status(400).json({ message: 'Энэ имэйл бүртгэлтэй байна' });
      }

      const now = new Date();
      const cooldownAfter = new Date(now.getTime() - OTP_COOLDOWN_MS);
      const lastRequest = await prisma.otpVerification.findFirst({
        where: {
          userId: req.user.id,
          purpose: PURPOSE_PROFILE_EMAIL,
          destination: newEmail,
          createdAt: { gte: cooldownAfter },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (lastRequest) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((OTP_COOLDOWN_MS - (now.getTime() - lastRequest.createdAt.getTime())) / 1000)
        );
        return res.status(429).json({
          message: `OTP дахин авахын тулд ${retryAfterSeconds} сек хүлээнэ үү`,
          retryAfterSeconds,
        });
      }

      const code = generateOtpCode();
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + OTP_EXPIRES_MS);

      await prisma.otpVerification.create({
        data: {
          channel: 'email',
          destination: newEmail,
          purpose: PURPOSE_PROFILE_EMAIL,
          codeHash,
          expiresAt,
          userId: req.user.id,
        },
      });

      const payload = { message: 'Имэйл рүү OTP илгээгдлээ' };
      if (process.env.NODE_ENV !== 'production') payload.otp = code;
      res.status(201).json(payload);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

/** Имэйл солих — OTP баталгаажуулалт */
userRoutes.post(
  '/profile/confirm-email-change',
  [
    body('newEmail').trim().isEmail(),
    body('code').trim().isLength({ min: 4, max: 8 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const newEmail = normalizeEmail(req.body.newEmail);
      const code = String(req.body.code).trim();

      const otp = await prisma.otpVerification.findFirst({
        where: {
          userId: req.user.id,
          destination: newEmail,
          purpose: PURPOSE_PROFILE_EMAIL,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!otp) {
        return res.status(400).json({ message: 'OTP буруу эсвэл хугацаа дууссан' });
      }

      const ok = await bcrypt.compare(code, otp.codeHash);
      if (!ok) {
        return res.status(400).json({ message: 'OTP буруу байна' });
      }

      await prisma.otpVerification.update({
        where: { id: otp.id },
        data: { usedAt: new Date() },
      });

      const user = await prisma.user.update({
        where: { id: req.user.id },
        data: { email: newEmail },
        select: { id: true, name: true, email: true, role: true, phone: true, avatar: true },
      });
      res.json(user);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

/** Ажилтан урилга — 6 оронтой код эсвэл хуучин JWT token аль алийг дэмжинэ */
userRoutes.post(
  '/accept-staff-invite',
  [body('token').trim().notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const raw = req.body.token.trim();
      let businessId, memberRole, ownerId;

      // 6 оронтой тоон код эсэх шалгах
      if (/^\d{6}$/.test(raw)) {
        const record = await prisma.staffInviteCode.findUnique({ where: { code: raw } });
        if (!record || record.usedAt || new Date() > record.expiresAt) {
          return res.status(400).json({ message: 'Урилгын код хүчингүй эсвэл хугацаа дууссан' });
        }
        businessId = record.businessId;
        memberRole = record.memberRole === 'manager' ? 'manager' : 'staff';
        // Mark as used
        await prisma.staffInviteCode.update({
          where: { id: record.id },
          data: { usedAt: new Date(), usedBy: req.user.id },
        });
      } else {
        // Хуучин JWT token (backward compatibility)
        let payload;
        try {
          payload = verifyJwt(raw);
        } catch {
          return res.status(400).json({ message: 'Урилгын код хүчингүй эсвэл хугацаа дууссан' });
        }
        if (payload.purpose !== 'staff_qr_invite' || !payload.businessId) {
          return res.status(400).json({ message: 'Буруу урилга' });
        }
        businessId = payload.businessId;
        memberRole = payload.memberRole === 'manager' ? 'manager' : 'staff';
      }

      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, name: true, ownerId: true, status: true },
      });
      if (!business || business.status !== 'approved') {
        return res.status(404).json({ message: 'Бизнес олдсонгүй' });
      }
      ownerId = business.ownerId;

      await prisma.businessMember.upsert({
        where: { businessId_userId: { businessId: business.id, userId: req.user.id } },
        create: {
          businessId: business.id,
          userId: req.user.id,
          role: memberRole,
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: ownerId,
        },
        update: {
          role: memberRole,
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: ownerId,
        },
      });

      await prisma.user.update({
        where: { id: req.user.id },
        data: { role: memberRole === 'manager' ? 'manager' : 'staff' },
      });

      const me = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { name: true, phone: true, email: true },
      });
      const orCond = [];
      if (me?.phone) orCond.push({ phone: me.phone });
      if (me?.email) orCond.push({ email: me.email });
      let existingStaff = null;
      if (orCond.length) {
        existingStaff = await prisma.staff.findFirst({
          where: { businessId: business.id, OR: orCond },
          select: { id: true },
        });
      }
      if (!existingStaff) {
        await prisma.staff.create({
          data: {
            businessId: business.id,
            name: me?.name || 'Ажилтан',
            phone: me?.phone,
            email: me?.email,
            role: memberRole === 'manager' ? 'Senior' : 'Employee',
          },
        });
      }

      res.json({ ok: true, businessId: business.id, businessName: business.name, memberRole });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

/** Эзэмшигчээс ирсэн pending урилгыг зөвшөөрөх */
userRoutes.post('/business-invitations/:memberId/accept', async (req, res) => {
  try {
    const member = await prisma.businessMember.findFirst({
      where: { id: req.params.memberId, userId: req.user.id, status: 'pending' },
      include: { business: { select: { id: true, name: true, ownerId: true } } },
    });
    if (!member) {
      return res.status(404).json({ message: 'Урилга олдсонгүй' });
    }

    const updated = await prisma.businessMember.update({
      where: { id: member.id },
      data: {
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: member.business.ownerId,
      },
    });

    const mappedRole = updated.role === 'manager' ? 'manager' : 'staff';
    await prisma.user.update({
      where: { id: req.user.id },
      data: { role: mappedRole },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

userRoutes.get('/my-businesses', async (req, res) => {
  try {
    const businesses = await prisma.business.findMany({
      where: { ownerId: req.user.id },
    });
    res.json(businesses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

userRoutes.get('/favorites', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        favoriteBusinesses: {
          select: {
            id: true,
            name: true,
            images: true,
            addressCity: true,
            addressStreet: true,
            rating: true,
          },
        },
      },
    });
    res.json(user?.favoriteBusinesses ?? []);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

userRoutes.post('/favorites/:businessId', async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        favoriteBusinesses: { connect: { id: req.params.businessId } },
      },
    });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { favoriteBusinesses: { select: { id: true } } },
    });
    res.json({ success: true, favorites: user.favoriteBusinesses });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ message: 'Business not found' });
    res.status(500).json({ message: err.message });
  }
});

userRoutes.delete('/favorites/:businessId', async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        favoriteBusinesses: { disconnect: { id: req.params.businessId } },
      },
      select: { favoriteBusinesses: { select: { id: true } } },
    });
    res.json({ success: true, favorites: user.favoriteBusinesses });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
