import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import path from 'path';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { connectDB } from './config/db.js';
import { authRoutes } from './routes/auth.js';
import { businessRoutes } from './routes/business.js';
import { bookingRoutes } from './routes/booking.js';
import { userRoutes } from './routes/user.js';
import { searchRoutes } from './routes/search.js';
import { reviewRoutes } from './routes/review.js';
import { notificationRoutes } from './routes/notification.js';
import { businessOwnerRoutes } from './routes/businessOwner.js';
import { protect } from './middleware/auth.js';
import { adminRouter } from './routes/admin/index.js';
import { uploadRoutes } from './routes/upload.js';
import { runPendingBookingTimeoutSweep } from './jobs/pendingBookingTimeout.js';
import { paymentRoutes } from './routes/payment.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { locationRoutes } from './routes/location.js';
import { messagingRoutes } from './routes/messaging.js';
import { startSubscriptionWarningJob } from './jobs/subscriptionWarningJob.js';
import { startBookingReminderJob } from './jobs/bookingReminderJob.js';
import { startChatCleanupJob } from './jobs/chatCleanupJob.js';

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Rate limiting ────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Хэт олон хүсэлт. 15 минутын дараа дахин оролдоно уу.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Хэт олон нэвтрэх оролдлого. 15 минутын дараа дахин оролдоно уу.' },
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минут
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Захиалгын хүсэлт хэт олон. Түр хүлээгээд дахин оролдоно уу.' },
});

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools (curl/postman) without Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use('/api', globalLimiter);
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(path.resolve(uploadDir)));

app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Qtime API is running' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/bookings', bookingLimiter, bookingRoutes);
app.use('/api/users', userRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/business-owner', businessOwnerRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin', protect, adminRouter);
app.use('/api/payments', paymentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/messages', messagingRoutes);

app.use((err, req, res, next) => {
  if (err && err.message && String(err.message).startsWith('CORS blocked')) {
    return res.status(403).json({ message: err.message });
  }
  return next(err);
});

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    runPendingBookingTimeoutSweep().catch((e) => console.error('[pending-timeout] initial sweep', e));
    setInterval(() => {
      runPendingBookingTimeoutSweep().catch((e) => console.error('[pending-timeout] sweep', e));
    }, 60_000);
    startSubscriptionWarningJob();
    startBookingReminderJob();
    startChatCleanupJob();
  });
}

start();
