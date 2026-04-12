/**
 * Admin CSV Export Routes
 * GET /api/admin/csv/bookings  — захиалгууд
 * GET /api/admin/csv/payments  — төлбөрүүд
 * GET /api/admin/csv/users     — хэрэглэгчид
 */

import express from 'express';
import { prisma } from '../../config/db.js';

export const csvRouter = express.Router();

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, headers) {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  }
  return lines.join('\r\n');
}

function dateStr(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// GET /api/admin/csv/bookings
csvRouter.get('/bookings', async (req, res) => {
  try {
    const { from, to, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        business: { select: { name: true, addressCity: true } },
        staff: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const rows = bookings.map((b) => ({
      ID: b.id,
      'Статус': b.status,
      'Үйлчилгээ': b.serviceName,
      'Үнэ (₮)': b.servicePrice ?? '',
      'Захиалагч': b.customer?.name ?? '',
      'Email': b.customer?.email ?? '',
      'Утас': b.customer?.phone ?? '',
      'Бизнес': b.business?.name ?? '',
      'Хот': b.business?.addressCity ?? '',
      'Мастер': b.staff?.name ?? '',
      'Эхлэх цаг': dateStr(b.startTime),
      'Дуусах цаг': dateStr(b.endTime),
      'Үүсгэсэн': dateStr(b.createdAt),
    }));

    const headers = ['ID', 'Статус', 'Үйлчилгээ', 'Үнэ (₮)', 'Захиалагч', 'Email', 'Утас', 'Бизнес', 'Хот', 'Мастер', 'Эхлэх цаг', 'Дуусах цаг', 'Үүсгэсэн'];
    const csv = toCsv(rows, headers);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookez-bookings-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/csv/payments
csvRouter.get('/payments', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = { status: { not: 'cancelled' } };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: { select: { name: true, email: true } },
        business: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const rows = bookings.map((b) => ({
      'Захиалга ID': b.id,
      'Статус': b.status,
      'Дүн (₮)': b.servicePrice ?? 0,
      'Үйлчилгээ': b.serviceName,
      'Захиалагч': b.customer?.name ?? '',
      'Email': b.customer?.email ?? '',
      'Бизнес': b.business?.name ?? '',
      'Огноо': dateStr(b.startTime),
      'Үүсгэсэн': dateStr(b.createdAt),
    }));

    const headers = ['Захиалга ID', 'Статус', 'Дүн (₮)', 'Үйлчилгээ', 'Захиалагч', 'Email', 'Бизнес', 'Огноо', 'Үүсгэсэн'];
    const csv = toCsv(rows, headers);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookez-payments-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/csv/users
csvRouter.get('/users', async (req, res) => {
  try {
    const { role } = req.query;
    const where = {};
    if (role) where.role = role;

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
        _count: { select: { bookings: true, reviews: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const rows = users.map((u) => ({
      'ID': u.id,
      'Нэр': u.name ?? '',
      'Email': u.email ?? '',
      'Утас': u.phone ?? '',
      'Эрх': u.role,
      'Захиалга': u._count.bookings,
      'Үнэлгээ': u._count.reviews,
      'Бүртгэсэн': dateStr(u.createdAt),
    }));

    const headers = ['ID', 'Нэр', 'Email', 'Утас', 'Эрх', 'Захиалга', 'Үнэлгээ', 'Бүртгэсэн'];
    const csv = toCsv(rows, headers);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookez-users-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
