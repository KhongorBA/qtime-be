/**
 * Payment routes — QPay QR payment flow
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  DEPOSIT (20%)                                                   │
 * │  1. POST /api/payments/booking/:id/qpay-intent                   │
 * │       → QPay invoice үүсгэнэ, QR + deep links буцаана           │
 * │  2. Flutter: QR харуулах / банкны app нээх                       │
 * │  3. QPay webhook → POST /api/payments/webhook/qpay               │
 * │       (ЭСВЭЛ Flutter polling: GET /qpay-status)                  │
 * │       → depositCapturedAt тэмдэглэнэ                             │
 * │                                                                   │
 * │  REMAINDER (80%) — үйлчилгээ дуусмагц                           │
 * │  4. Business marks complete → POST /api/payments/booking/:id/complete │
 * │       → Шинэ QPay invoice 80%-д                                  │
 * │       → Хэрэглэгчид push notification                            │
 * │  5. Хэрэглэгч дахин QR уншуулна                                  │
 * │                                                                   │
 * │  REFUND                                                           │
 * │  6. POST /api/payments/booking/:id/refund                         │
 * │       → QPay payment_id-аар буцаалт хийнэ                        │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * MOCK: QPAY_MOCK=true → real API дуудалтгүй, console.log + fake data
 */

import express from 'express';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { getPlatformConfig } from '../utils/platformConfig.js';
import {
  createQPayInvoice,
  checkQPayPayment,
  refundQPayPayment,
} from '../utils/qpay.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

export const paymentRoutes = express.Router();

// Webhook endpoint must be BEFORE protect middleware (no auth header from QPay)
// All other routes require JWT auth
const webhookRouter = express.Router();
paymentRoutes.use('/webhook', webhookRouter);
paymentRoutes.use(protect);

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcAmounts(servicePrice, cfg) {
  const depositPct = parseFloat(cfg.deposit_percent || '20') / 100;
  const feePct     = parseFloat(cfg.platform_fee_percent || '5') / 100;
  const deposit    = Math.round(servicePrice * depositPct);
  const remainder  = Math.round(servicePrice - deposit);
  const fee        = Math.round(servicePrice * feePct);
  return { deposit, remainder, fee };
}

async function pushToUser(userId, title, body, data = {}) {
  const devices = await prisma.userDevice.findMany({
    where: { userId },
    select: { fcmToken: true, fcmApp: true },
  });
  let notif;
  try {
    notif = await prisma.notification.create({
      data: { userId, title, body, data },
    });
  } catch {}

  await Promise.all(
    devices.map((d) =>
      sendFcmMessage(
        d.fcmToken,
        { title, body },
        { ...data, ...(notif ? { id: notif.id } : {}) },
        d.fcmApp === 'business' ? 'business' : 'consumer',
      ),
    ),
  );
}

// ── 1. Create QPay deposit invoice ───────────────────────────────────────────
// POST /api/payments/booking/:bookingId/qpay-intent
paymentRoutes.post('/booking/:bookingId/qpay-intent', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const cfg = await getPlatformConfig();

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { business: { select: { name: true } }, payment: true },
    });
    if (!booking) return res.status(404).json({ message: 'Booking олдсонгүй' });
    if (booking.customerId !== req.user.id) {
      return res.status(403).json({ message: 'Зөвшөөрөлгүй' });
    }
    if (booking.payment?.depositCapturedAt) {
      return res.status(400).json({ message: 'Урьдчилгаа аль хэдийн төлөгдсөн' });
    }

    const { deposit, remainder, fee } = calcAmounts(booking.servicePrice, cfg);
    const webhookSecret = process.env.QPAY_WEBHOOK_SECRET;
    const callbackUrl = `${process.env.API_BASE_URL || 'http://localhost:5000'}/api/payments/webhook/qpay`
      + (webhookSecret ? `?secret=${encodeURIComponent(webhookSecret)}` : '');

    const invoice = await createQPayInvoice({
      amount: deposit,
      description: `${booking.business.name} — ${booking.serviceName}`,
      senderInvoiceNo: `dep_${bookingId}`,
      callbackUrl,
    });

    await prisma.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amount: booking.servicePrice,
        depositAmount: deposit,
        remainderAmount: remainder,
        platformFee: fee,
        depositIntentId: invoice.invoice_id,
        status: 'pending',
        method: 'qpay',
      },
      update: {
        depositIntentId: invoice.invoice_id,
        depositAmount: deposit,
        remainderAmount: remainder,
        platformFee: fee,
        method: 'qpay',
      },
    });

    console.log('[payment] qpay-intent created', {
      bookingId,
      depositAmount: deposit,
      invoiceId: invoice.invoice_id,
      mock: invoice._mock ?? false,
    });

    res.json({
      invoiceId: invoice.invoice_id,
      qrImage: invoice.qr_image,   // base64 PNG
      qrText:  invoice.qr_text,    // raw QR string
      deepLinks: invoice.urls,     // [{name, description, logo, link}]
      depositAmount: deposit,
      remainderAmount: remainder,
      currency: 'MNT',
    });
  } catch (err) {
    console.error('[qpay-intent]', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── 2. Poll payment status (Flutter polling) ─────────────────────────────────
// GET /api/payments/booking/:bookingId/qpay-status
paymentRoutes.get('/booking/:bookingId/qpay-status', async (req, res) => {
  try {
    const { bookingId } = req.params;

    const payment = await prisma.payment.findUnique({ where: { bookingId } });
    if (!payment) return res.json({ paid: false, status: 'no_payment' });

    // Already captured — just return status
    if (payment.depositCapturedAt) {
      return res.json({ paid: true, status: payment.status });
    }

    if (!payment.depositIntentId) {
      return res.json({ paid: false, status: 'pending' });
    }

    const result = await checkQPayPayment(payment.depositIntentId);

    console.log('[payment] qpay-status poll', {
      bookingId,
      invoiceId: payment.depositIntentId,
      paid: result.paid,
      mock: result.raw?._mock ?? false,
    });

    if (result.paid && !payment.depositCapturedAt) {
      await prisma.payment.update({
        where: { bookingId },
        data: {
          depositCapturedAt: new Date(),
          // Store QPay's payment_id for future refund
          externalId: result.paymentId ?? undefined,
        },
      });
    }

    res.json({
      paid: result.paid,
      paidAmount: result.paidAmount,
      paymentId: result.paymentId,
      status: payment.status,
    });
  } catch (err) {
    console.error('[qpay-status]', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Webhook secret guard ──────────────────────────────────────────────────────
// QPay callback URL-д ?secret=... нэмдэг тул query param-аар шалгана.
// QPAY_WEBHOOK_SECRET тохируулаагүй бол шалгалтыг алгасана (dev режим).
function verifyWebhookSecret(req, res) {
  const expected = process.env.QPAY_WEBHOOK_SECRET;
  if (!expected) return true; // not configured → allow (dev/mock)
  const provided = req.query.secret;
  if (!provided || provided !== expected) {
    console.warn('[webhook] Unauthorized — wrong or missing secret', { ip: req.ip });
    res.sendStatus(403);
    return false;
  }
  return true;
}

// ── 3. QPay webhook (no auth — called by QPay servers) ───────────────────────
// POST /api/payments/webhook/qpay
webhookRouter.post('/qpay', express.json(), async (req, res) => {
  try {
    if (!verifyWebhookSecret(req, res)) return;

    const body = req.body || {};
    console.log('[webhook] QPay callback received:', JSON.stringify(body));

    // QPay sends: { payment_id, invoice_id, payment_status, ... }
    if (body.payment_status !== 'PAID') {
      return res.sendStatus(200);
    }

    const invoiceId = body.invoice_id;
    if (!invoiceId) return res.sendStatus(400);

    const payment = await prisma.payment.findFirst({
      where: { depositIntentId: invoiceId },
    });

    if (!payment) {
      console.warn('[webhook] QPay: no Payment record for invoice', invoiceId);
      return res.sendStatus(200);
    }

    if (!payment.depositCapturedAt) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          depositCapturedAt: new Date(),
          externalId: body.payment_id ?? undefined,
        },
      });
      console.log('[webhook] QPay: deposit captured', {
        bookingId: payment.bookingId,
        paymentId: body.payment_id,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook/qpay]', err.message);
    res.sendStatus(500);
  }
});

// ── 4. Complete appointment → create remainder invoice ────────────────────────
// POST /api/payments/booking/:bookingId/complete
paymentRoutes.post('/booking/:bookingId/complete', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const cfg = await getPlatformConfig();

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        business: { select: { id: true, name: true, ownerId: true } },
      },
    });
    if (!booking) return res.status(404).json({ message: 'Booking олдсонгүй' });

    const isBusiness =
      booking.business.ownerId === req.user.id ||
      ['business_owner', 'manager', 'staff', 'admin'].includes(req.user.role);
    if (!isBusiness) return res.status(403).json({ message: 'Зөвшөөрөлгүй' });

    if (booking.payment?.remainderIntentId) {
      return res.status(400).json({ message: 'Үлдэгдэл invoice аль хэдийн үүссэн' });
    }

    const payment = booking.payment;
    const remainderAmt = payment?.remainderAmount
      ?? Math.round(booking.servicePrice * 0.8);

    const webhookSecret = process.env.QPAY_WEBHOOK_SECRET;
    const callbackUrl = `${process.env.API_BASE_URL || 'http://localhost:5000'}/api/payments/webhook/qpay-remainder`
      + (webhookSecret ? `?secret=${encodeURIComponent(webhookSecret)}` : '');

    const invoice = await createQPayInvoice({
      amount: remainderAmt,
      description: `Үлдэгдэл: ${booking.business.name} — ${booking.serviceName}`,
      senderInvoiceNo: `rem_${bookingId}`,
      callbackUrl,
    });

    // Update booking status to completed, store remainder invoice
    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId },
        data: { remainderIntentId: invoice.invoice_id },
      }),
      prisma.booking.update({ where: { id: bookingId }, data: { status: 'completed' } }),
      prisma.bookingStatusLog.create({
        data: {
          bookingId,
          oldStatus: booking.status,
          newStatus: 'completed',
          changedById: req.user.id,
          note: 'Completed — remainder invoice created',
        },
      }),
    ]);

    // Notify customer to pay the remainder
    await pushToUser(
      booking.customerId,
      '💳 Үлдэгдэл төлбөр',
      `${booking.business.name} — ${booking.serviceName} үйлчилгээ дууслаа. Үлдэгдэл ${remainderAmt.toLocaleString()}₮ төлнө үү.`,
      { type: 'payment_remainder', bookingId, invoiceId: invoice.invoice_id },
    );

    console.log('[payment] remainder invoice created', {
      bookingId,
      remainderAmount: remainderAmt,
      invoiceId: invoice.invoice_id,
      mock: invoice._mock ?? false,
    });

    res.json({
      invoiceId: invoice.invoice_id,
      qrImage: invoice.qr_image,
      qrText: invoice.qr_text,
      deepLinks: invoice.urls,
      remainderAmount: remainderAmt,
      currency: 'MNT',
    });
  } catch (err) {
    console.error('[complete-payment]', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── Remainder webhook ─────────────────────────────────────────────────────────
// POST /api/payments/webhook/qpay-remainder
webhookRouter.post('/qpay-remainder', express.json(), async (req, res) => {
  try {
    if (!verifyWebhookSecret(req, res)) return;

    const body = req.body || {};
    console.log('[webhook] QPay remainder callback:', JSON.stringify(body));

    if (body.payment_status !== 'PAID') return res.sendStatus(200);

    const invoiceId = body.invoice_id;
    const payment = await prisma.payment.findFirst({
      where: { remainderIntentId: invoiceId },
    });
    if (!payment) return res.sendStatus(200);

    if (!payment.remainderCapturedAt) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          remainderCapturedAt: new Date(),
          remainderExternalId: body.payment_id ?? undefined,
          status: 'completed',
        },
      });
      console.log('[webhook] QPay: remainder captured', {
        bookingId: payment.bookingId,
        paymentId: body.payment_id,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook/qpay-remainder]', err.message);
    res.sendStatus(500);
  }
});

// ── 5. Refund ─────────────────────────────────────────────────────────────────
// POST /api/payments/booking/:bookingId/refund
paymentRoutes.post('/booking/:bookingId/refund', async (req, res) => {
  try {
    const { bookingId } = req.params;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking) return res.status(404).json({ message: 'Booking олдсонгүй' });

    const isCustomer = booking.customerId === req.user.id;
    const isBusiness = ['business_owner', 'manager', 'admin'].includes(req.user.role);
    if (!isCustomer && !isBusiness) {
      return res.status(403).json({ message: 'Зөвшөөрөлгүй' });
    }

    const payment = booking.payment;
    const refunds = [];

    // Refund deposit
    if (payment?.externalId && payment.depositCapturedAt) {
      try {
        const r = await refundQPayPayment(payment.externalId);
        refunds.push({ type: 'deposit', success: r.success });
      } catch (e) {
        console.error('[refund] deposit refund failed:', e.message);
        refunds.push({ type: 'deposit', success: false, error: e.message });
      }
    }

    // Refund remainder if already paid
    if (payment?.remainderCapturedAt && payment?.remainderExternalId) {
      try {
        const r = await refundQPayPayment(payment.remainderExternalId);
        refunds.push({ type: 'remainder', success: r.success });
      } catch (e) {
        console.error('[refund] remainder refund failed:', e.message);
        refunds.push({ type: 'remainder', success: false, error: e.message });
      }
    } else if (payment?.remainderCapturedAt) {
      console.warn('[refund] remainder captured but no paymentId stored — manual refund required');
      refunds.push({ type: 'remainder', success: false, note: 'Manual refund required' });
    }

    await prisma.$transaction([
      ...(payment
        ? [prisma.payment.update({
            where: { bookingId },
            data: { status: 'refunded', refundedAt: new Date() },
          })]
        : []),
      prisma.booking.update({ where: { id: bookingId }, data: { status: 'cancelled' } }),
      prisma.bookingStatusLog.create({
        data: {
          bookingId,
          oldStatus: booking.status,
          newStatus: 'cancelled',
          changedById: req.user.id,
          note: `Cancelled with refund`,
        },
      }),
    ]);

    console.log('[payment] refund processed', { bookingId, refunds });
    res.json({ success: true, refunds });
  } catch (err) {
    console.error('[refund]', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── 6. Get payment info ───────────────────────────────────────────────────────
// GET /api/payments/booking/:bookingId
paymentRoutes.get('/booking/:bookingId', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { payment: true },
    });
    if (!booking) return res.status(404).json({ message: 'Booking олдсонгүй' });

    const canView =
      booking.customerId === req.user.id ||
      ['business_owner', 'manager', 'admin'].includes(req.user.role);
    if (!canView) return res.status(403).json({ message: 'Зөвшөөрөлгүй' });

    res.json(booking.payment ?? { status: 'no_payment' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
