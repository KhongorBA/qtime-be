/**
 * OTP notification utility
 * EMAIL: Nodemailer (SMTP)
 * SMS:   placeholder — integrate your provider (Twilio, Infobip, etc.)
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
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

/**
 * Send OTP via email using Nodemailer.
 * If SMTP_HOST is not configured, logs to console (dev mode).
 */
export async function sendOtpEmail(destination, code) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[OTP EMAIL] SMTP not configured. OTP for ${destination}: ${code}`);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Bookez" <noreply@bookez.mn>`,
    to: destination,
    subject: 'Bookez — Таны баталгаажуулах код',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0F2224;border-radius:16px">
        <h2 style="color:#00E5A0;margin:0 0 8px">Bookez</h2>
        <p style="color:#94A3B8;margin:0 0 24px">Таны баталгаажуулах код:</p>
        <div style="background:#152526;border-radius:12px;padding:20px;text-align:center">
          <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#ffffff">${code}</span>
        </div>
        <p style="color:#94A3B8;font-size:13px;margin:20px 0 0">
          Энэ код 5 минутын дараа хүчингүй болно.<br>
          Хэрэв та энэ хүсэлт өгөөгүй бол үл тоомсорлоно уу.
        </p>
      </div>
    `,
    text: `Таны Bookez баталгаажуулах код: ${code}\n\n5 минутад хүчтэй.`,
  });
  console.log(`[OTP EMAIL] Sent to ${destination}`);
}

/**
 * Send OTP via SMS.
 * Currently logs to console — replace with your SMS provider.
 */
export async function sendOtpSms(destination, code) {
  // TODO: integrate SMS provider (e.g. Twilio, Infobip, Unitel/Mobicom MNO API)
  console.warn(`[OTP SMS] Provider not configured. OTP for ${destination}: ${code}`);
}

/**
 * Route OTP to the right channel.
 */
export async function sendOtpNotification(channel, destination, code) {
  if (channel === 'email') {
    await sendOtpEmail(destination, code);
  } else if (channel === 'phone') {
    await sendOtpSms(destination, code);
  }
}
