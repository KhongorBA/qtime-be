/**
 * Email Service — захиалгын мэдэгдэл, баримт илгээх
 * SMTP тохиргоо: .env файлд SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import nodemailer from 'nodemailer';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  _transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transporter;
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[EMAIL] SMTP тохиргоогүй — ${subject} → ${to}`);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Qtime" <noreply@qtime.mn>',
    to,
    subject,
    html,
    text,
  });
  console.log(`[EMAIL] Sent: ${subject} → ${to}`);
}

const STATUS_LABELS = {
  confirmed: 'Баталгаажсан',
  cancelled: 'Цуцлагдсан',
  completed: 'Дууссан',
  owner_timeout: 'Хариу ирээгүй',
  no_show: 'Ирээгүй',
};

const STATUS_COLORS = {
  confirmed: '#10B981',
  cancelled: '#EF4444',
  completed: '#6366F1',
  owner_timeout: '#F59E0B',
  no_show: '#9CA3AF',
};

function baseLayout(content) {
  return `
<!DOCTYPE html>
<html lang="mn">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A1214;font-family:system-ui,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#0F2224;border-radius:16px;overflow:hidden">
    <div style="background:#152526;padding:24px 28px;border-bottom:1px solid #1E3A3C">
      <span style="font-size:22px;font-weight:800;color:#12C9A3">Qtime</span>
    </div>
    <div style="padding:28px">
      ${content}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #1E3A3C;text-align:center">
      <p style="color:#4B5563;font-size:12px;margin:0">© 2025 Qtime. Бүх эрх хуулиар хамгаалагдсан.</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Захиалгын статус өөрчлөгдсөн үед хэрэглэгчид мэдэгдэл илгээх
 */
export async function sendBookingStatusEmail({ to, customerName, businessName, serviceName, startTime, status, bookingId }) {
  if (!to) return;
  const label = STATUS_LABELS[status] || status;
  const color = STATUS_COLORS[status] || '#12C9A3';
  const dateStr = new Date(startTime).toLocaleString('mn-MN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const html = baseLayout(`
    <h2 style="color:#F9FAFB;margin:0 0 8px;font-size:20px">Захиалгын мэдэгдэл</h2>
    <p style="color:#9CA3AF;margin:0 0 24px;font-size:14px">Таны захиалгын төлөв өөрчлөгдлөө</p>

    <div style="background:#152526;border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <span style="color:#9CA3AF;font-size:13px">Статус</span>
        <span style="background:${color}22;color:${color};padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">${label}</span>
      </div>
      <div style="margin-bottom:10px">
        <span style="color:#9CA3AF;font-size:12px">Бизнес</span>
        <p style="color:#F9FAFB;margin:2px 0 0;font-weight:600">${businessName}</p>
      </div>
      <div style="margin-bottom:10px">
        <span style="color:#9CA3AF;font-size:12px">Үйлчилгээ</span>
        <p style="color:#F9FAFB;margin:2px 0 0">${serviceName}</p>
      </div>
      <div>
        <span style="color:#9CA3AF;font-size:12px">Цаг</span>
        <p style="color:#F9FAFB;margin:2px 0 0">${dateStr}</p>
      </div>
    </div>

    <p style="color:#6B7280;font-size:13px;margin:0">Захиалга #${bookingId?.slice(-8)?.toUpperCase()}</p>
  `);

  await sendMail({
    to,
    subject: `Qtime — Захиалга ${label}: ${businessName}`,
    html,
    text: `Сайн байна уу ${customerName},\n\nТаны ${businessName}-д хийсэн "${serviceName}" захиалга ${label} болсон.\nЦаг: ${dateStr}\n\nBookez`,
  });
}

/**
 * Захиалгын сануулга — уулзалтаас 24 цагийн өмнө
 */
export async function sendBookingReminderEmail({ to, customerName, businessName, serviceName, startTime, businessPhone }) {
  if (!to) return;
  const dateStr = new Date(startTime).toLocaleString('mn-MN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const html = baseLayout(`
    <h2 style="color:#F9FAFB;margin:0 0 8px;font-size:20px">Захиалгын сануулга ⏰</h2>
    <p style="color:#9CA3AF;margin:0 0 24px;font-size:14px">Маргааш таны цаг болно</p>

    <div style="background:#152526;border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Бизнес</span>
        <p style="color:#F9FAFB;margin:2px 0 0;font-weight:600">${businessName}</p>
      </div>
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Үйлчилгээ</span>
        <p style="color:#F9FAFB;margin:2px 0 0">${serviceName}</p>
      </div>
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Цаг</span>
        <p style="color:#12C9A3;margin:2px 0 0;font-weight:700;font-size:16px">${dateStr}</p>
      </div>
      ${businessPhone ? `<div><span style="color:#9CA3AF;font-size:12px">Холбоо барих</span><p style="color:#F9FAFB;margin:2px 0 0">${businessPhone}</p></div>` : ''}
    </div>

    <p style="color:#6B7280;font-size:13px">Цуцлах шаардлагатай бол Qtime аппаас захиалгаа цуцална уу.</p>
  `);

  await sendMail({
    to,
    subject: `Qtime — Маргааш ${businessName}-д таны цаг болно`,
    html,
    text: `Сайн байна уу ${customerName},\n\nМаргааш ${businessName}-д "${serviceName}" үйлчилгээ авах цаг таны болно.\nЦаг: ${dateStr}\n\nBookez`,
  });
}

/**
 * PDF баримтын мэдэгдэл (баримтыг attachment болгон)
 */
export async function sendReceiptEmail({ to, customerName, businessName, serviceName, amount, startTime, bookingId, pdfBuffer }) {
  if (!to) return;
  const dateStr = new Date(startTime).toLocaleString('mn-MN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const amountStr = `${Number(amount).toLocaleString('mn-MN')}₮`;

  const html = baseLayout(`
    <h2 style="color:#F9FAFB;margin:0 0 8px;font-size:20px">Төлбөрийн баримт</h2>
    <p style="color:#9CA3AF;margin:0 0 24px;font-size:14px">Таны захиалгын баримт хавсаргагдсан байна</p>

    <div style="background:#152526;border-radius:12px;padding:20px">
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Бизнес</span>
        <p style="color:#F9FAFB;margin:2px 0 0;font-weight:600">${businessName}</p>
      </div>
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Үйлчилгээ</span>
        <p style="color:#F9FAFB;margin:2px 0 0">${serviceName}</p>
      </div>
      <div style="margin-bottom:12px">
        <span style="color:#9CA3AF;font-size:12px">Огноо</span>
        <p style="color:#F9FAFB;margin:2px 0 0">${dateStr}</p>
      </div>
      <div style="border-top:1px solid #1E3A3C;padding-top:12px;margin-top:4px">
        <span style="color:#9CA3AF;font-size:12px">Нийт дүн</span>
        <p style="color:#12C9A3;margin:2px 0 0;font-weight:700;font-size:18px">${amountStr}</p>
      </div>
    </div>
  `);

  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[EMAIL] SMTP тохиргоогүй — receipt → ${to}`);
    return;
  }

  const mailOpts = {
    from: process.env.SMTP_FROM || '"Qtime" <noreply@qtime.mn>',
    to,
    subject: `Qtime — Баримт: ${businessName}`,
    html,
    text: `${customerName} таны ${businessName} - "${serviceName}" захиалгын баримт.\nДүн: ${amountStr}`,
  };

  if (pdfBuffer) {
    mailOpts.attachments = [{
      filename: `qtime-receipt-${bookingId?.slice(-8)?.toUpperCase()}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }];
  }

  await transporter.sendMail(mailOpts);
  console.log(`[EMAIL] Receipt sent → ${to}`);
}
