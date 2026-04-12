import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../../config/db.js';

export const usersRouter = express.Router();

// GET /api/admin/users - бүх хэрэглэгч
usersRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, role, search } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const where = {};
    if (role) where.role = role;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true, avatar: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit, 10),
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/users/:id - хэрэглэгчийн email/phone/role засах
usersRouter.patch(
  '/:id',
  [
    body('email').optional().isEmail().withMessage('Invalid email'),
    body('phone').optional().trim(),
    body('role').optional().isIn(['customer', 'business_owner', 'manager', 'staff', 'admin']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const { email, phone, role } = req.body;
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: 'User not found' });

      if (email && email !== existing.email) {
        const duplicate = await prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, NOT: { id } },
          select: { id: true },
        });
        if (duplicate) return res.status(400).json({ message: 'Email already exists' });
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
          email: email?.trim() ?? existing.email,
          phone: phone !== undefined ? (phone?.trim() || null) : existing.phone,
          role: role ?? existing.role,
        },
        select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true, avatar: true },
      });

      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// DELETE /api/admin/users/:id - хэрэглэгч устгах
usersRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!existing) return res.status(404).json({ message: 'User not found' });

    // Системийн admin-ыг устгахаас сэргийлнэ
    if (existing.role === 'admin') {
      return res.status(400).json({ message: 'Admin хэрэглэгч устгах боломжгүй' });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
