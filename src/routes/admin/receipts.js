/**
 * Admin Receipt/Invoice Routes
 * GET /api/admin/receipts/:bookingId  — PDF баримт татах
 * POST /api/admin/receipts/:bookingId/send — Email-ээр баримт илгээх
 */

import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { prisma } from '../../config/db.js';
import { sendReceiptEmail } from '../../utils/emailService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(__dirname, '../../../assets/fonts/NotoSans-Regular.ttf');
const FONT_BOLD = join(__dirname, '../../../assets/fonts/NotoSans-Bold.ttf');
const LOCALES_DIR = join(__dirname, '../../../locales');

const receiptLocaleCache = {};

function loadReceiptLocale(lang) {
  const key = lang === 'en' ? 'en' : 'mn';
  if (receiptLocaleCache[key]) return receiptLocaleCache[key];
  const file = key === 'en' ? 'receipt-en.json' : 'receipt-mn.json';
  const fp = join(LOCALES_DIR, file);
  try {
    receiptLocaleCache[key] = JSON.parse(readFileSync(fp, 'utf8'));
  } catch {
    receiptLocaleCache[key] = {};
  }
  return receiptLocaleCache[key];
}

function rt(lang, messageKey) {
  const pack = loadReceiptLocale(lang);
  return pack[messageKey] ?? messageKey;
}

/** PDFKit default Helvetica has no Cyrillic; Noto Sans covers Mongolian Cyrillic + ₮ */
function resolvePdfFonts(doc) {
  if (existsSync(FONT_REGULAR) && existsSync(FONT_BOLD)) {
    doc.registerFont('NotoSans', FONT_REGULAR);
    doc.registerFont('NotoSans-Bold', FONT_BOLD);
    return { regular: 'NotoSans', bold: 'NotoSans-Bold' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

export const receiptsRouter = express.Router();

async function getBookingWithDetails(bookingId) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      business: { select: { id: true, name: true, email: true, phone: true, addressCity: true, addressStreet: true } },
      staff: { select: { id: true, name: true } },
    },
  });
}

/**
 * Баримтын дугаар: захиалгын (Booking) ID-ийн сүүлийн 8 тэмдэгт, жишээ нь cuid-ийн төгсгөл.
 * Жинхэнэ бүтэн ID биш — зөвхөн харагдах богино дугаар.
 */
function generatePdfBuffer(booking, lang = 'mn') {
  const locale = lang === 'en' ? 'en' : 'mn';
  const dateLocale = locale === 'en' ? 'en-GB' : 'mn-MN';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const font = resolvePdfFonts(doc);
    const primaryColor = '#12C9A3';
    const darkBg = '#0F2224';
    const textColor = '#1F2937';
    const mutedColor = '#6B7280';

    // Header background
    doc.rect(0, 0, doc.page.width, 100).fill(darkBg);

    // Logo / brand
    doc.fontSize(26).fillColor(primaryColor).font(font.bold).text('Qtime', 50, 30);
    doc.fontSize(11).fillColor('#94A3B8').font(font.regular).text(rt(locale, 'r_subtitle'), 50, 62);

    // Receipt ID & date top-right
    const receiptNo = `#${booking.id.slice(-8).toUpperCase()}`;
    const issuedDate = new Date().toLocaleDateString(dateLocale);
    doc.fontSize(10).fillColor('#94A3B8').font(font.regular)
      .text(`${rt(locale, 'r_receiptNo')}: ${receiptNo}`, 0, 30, { align: 'right', width: doc.page.width - 50 });
    doc.text(`${rt(locale, 'r_date')}: ${issuedDate}`, 0, 48, { align: 'right', width: doc.page.width - 50 });

    doc.moveDown(4);

    // Divider
    doc.moveTo(50, 110).lineTo(doc.page.width - 50, 110).strokeColor('#E5E7EB').stroke();

    // Two columns: customer & business
    const colLeft = 50;
    const colRight = 310;
    const y0 = 125;

    doc.fontSize(9).fillColor(mutedColor).font(font.regular).text(rt(locale, 'r_customer'), colLeft, y0);
    doc.fontSize(12).fillColor(textColor).font(font.bold).text(booking.customer?.name || '-', colLeft, y0 + 14);
    if (booking.customer?.email) doc.fontSize(10).fillColor(mutedColor).font(font.regular).text(booking.customer.email, colLeft, y0 + 30);
    if (booking.customer?.phone) doc.font(font.regular).text(booking.customer.phone, colLeft, y0 + 44);

    doc.fontSize(9).fillColor(mutedColor).font(font.regular).text(rt(locale, 'r_business'), colRight, y0);
    doc.fontSize(12).fillColor(textColor).font(font.bold).text(booking.business?.name || '-', colRight, y0 + 14);
    if (booking.business?.addressCity) doc.fontSize(10).fillColor(mutedColor).font(font.regular).text(booking.business.addressCity, colRight, y0 + 30);
    if (booking.business?.phone) doc.font(font.regular).text(booking.business.phone, colRight, y0 + 44);

    // Service table — багануудыг тусгаарлах (цаг vs мастер давхцахгүй)
    const xPad = colLeft + 8;
    const wService = 172;
    const xTime = xPad + wService + 12;
    const wTime = 110;
    const xMaster = xTime + wTime + 14;
    const wMaster = 118;
    const xAmount = xMaster + wMaster + 8;
    const wAmount = doc.page.width - 50 - xAmount;

    const tableY = y0 + 80;
    doc.rect(colLeft, tableY, doc.page.width - 100, 28).fill('#F9FAFB');
    doc.fontSize(9).fillColor(mutedColor).font(font.bold)
      .text(rt(locale, 'r_service_col'), xPad, tableY + 8, { width: wService })
      .text(rt(locale, 'r_time_col'), xTime, tableY + 8, { width: wTime })
      .text(rt(locale, 'r_master_col'), xMaster, tableY + 8, { width: wMaster })
      .text(rt(locale, 'r_amount_col'), xAmount, tableY + 8, { width: wAmount, align: 'right' });

    const rowY = tableY + 36;
    const startStr = new Date(booking.startTime).toLocaleString(dateLocale, {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    doc.fontSize(11).fillColor(textColor).font(font.regular)
      .text(booking.serviceName || '-', xPad, rowY, { width: wService })
      .text(startStr, xTime, rowY, { width: wTime })
      .text(booking.staff?.name || '-', xMaster, rowY, { width: wMaster });

    const amount = booking.servicePrice ?? 0;
    const amountStr = `${Number(amount).toLocaleString(locale === 'en' ? 'en' : 'mn-MN')}₮`;
    doc.fontSize(11).fillColor(textColor).font(font.bold)
      .text(amountStr, xAmount, rowY, { width: wAmount, align: 'right' });

    // Total box
    const totalY = rowY + 50;
    doc.rect(colLeft + 320, totalY, doc.page.width - 50 - (colLeft + 320), 44).fill('#F0FDF9');
    doc.fontSize(10).fillColor(mutedColor).font(font.regular).text(rt(locale, 'r_total'), colLeft + 330, totalY + 8);
    doc.fontSize(16).fillColor('#065F46').font(font.bold)
      .text(amountStr, colLeft + 330, totalY + 22);

    // Status badge
    const statusKey = `status_${booking.status}`;
    const statusLabel = rt(locale, statusKey) !== statusKey ? rt(locale, statusKey) : booking.status;
    doc.fontSize(10).fillColor(mutedColor).font(font.regular)
      .text(`${rt(locale, 'r_status')}: ${statusLabel}`, colLeft, totalY + 14);

    // Footer
    const footerY = doc.page.height - 70;
    doc.moveTo(50, footerY - 10).lineTo(doc.page.width - 50, footerY - 10).strokeColor('#E5E7EB').stroke();
    doc.fontSize(9).fillColor(mutedColor).font(font.regular)
      .text(rt(locale, 'r_footer'), 50, footerY, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}

// GET /api/admin/receipts/:bookingId — PDF татах
receiptsRouter.get('/:bookingId', async (req, res) => {
  try {
    const booking = await getBookingWithDetails(req.params.bookingId);
    if (!booking) return res.status(404).json({ message: 'Захиалга олдсонгүй' });

    const lang = req.query.lang === 'en' ? 'en' : 'mn';
    const pdfBuffer = await generatePdfBuffer(booking, lang);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="qtime-receipt-${booking.id.slice(-8).toUpperCase()}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/receipts/:bookingId/send — Email-ээр илгээх
receiptsRouter.post('/:bookingId/send', async (req, res) => {
  try {
    const booking = await getBookingWithDetails(req.params.bookingId);
    if (!booking) return res.status(404).json({ message: 'Захиалга олдсонгүй' });

    const to = req.body.email || booking.customer?.email;
    if (!to) return res.status(400).json({ message: 'Email хаяг олдсонгүй' });

    const lang = req.body.lang === 'en' ? 'en' : 'mn';
    const pdfBuffer = await generatePdfBuffer(booking, lang);
    await sendReceiptEmail({
      to,
      customerName: booking.customer?.name || 'Хэрэглэгч',
      businessName: booking.business?.name || '',
      serviceName: booking.serviceName,
      amount: booking.servicePrice ?? 0,
      startTime: booking.startTime,
      bookingId: booking.id,
      pdfBuffer,
    });

    res.json({ message: 'Баримт амжилттай илгээгдлэй', to });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
