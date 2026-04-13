import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { prisma } from '../config/db.js';

function isStaleFcmTokenError(err) {
  const code = err?.code || err?.errorInfo?.code || '';
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/not-found' ||
    msg.includes('requested entity was not found') ||
    msg.includes('not a valid fcm registration token')
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = join(__dirname, '../../serviceAccountKey.json');
const BUSINESS_APP_NAME = 'qtime-partner-fcm';

let fb = null;
let consumerMessaging = null;
let businessMessaging = null;

function consumerServiceAccountPath() {
  return process.env.FIREBASE_SERVICE_ACCOUNT_PATH || DEFAULT_KEY;
}

function businessServiceAccountPath() {
  const p = process.env.FIREBASE_BUSINESS_SERVICE_ACCOUNT_PATH;
  if (p && String(p).trim()) return String(p).trim();
  return consumerServiceAccountPath();
}

export async function ensureFirebaseMessaging() {
  if (consumerMessaging && businessMessaging) {
    return { consumer: consumerMessaging, business: businessMessaging };
  }

  try {
    const mod = await import('firebase-admin');
    fb = mod.default;

    const cPath = consumerServiceAccountPath();
    if (!existsSync(cPath)) {
      console.warn('[FCM] consumer service account олдсонгүй:', cPath);
      return { consumer: null, business: null };
    }

    if (consumerMessaging === null) {
      if (fb.apps.length === 0) {
        const cred = JSON.parse(readFileSync(cPath, 'utf8'));
        fb.initializeApp({ credential: fb.credential.cert(cred) });
      }
      consumerMessaging = fb.app().messaging();
      console.log('[FCM] Firebase Admin (consumer) инициализлагдлаа');
    }

    const bPath = businessServiceAccountPath();
    if (businessMessaging === null) {
      if (bPath === cPath) {
        businessMessaging = consumerMessaging;
        console.log('[FCM] business = ижил төсөл');
      } else if (!existsSync(bPath)) {
        console.warn('[FCM] FIREBASE_BUSINESS_SERVICE_ACCOUNT_PATH олдсонгүй, consumer ашиглана:', bPath);
        businessMessaging = consumerMessaging;
      } else {
        const credB = JSON.parse(readFileSync(bPath, 'utf8'));
        try {
          fb.initializeApp({ credential: fb.credential.cert(credB) }, BUSINESS_APP_NAME);
        } catch (e) {
          if (e?.code !== 'app/duplicate-app') throw e;
        }
        businessMessaging = fb.app(BUSINESS_APP_NAME).messaging();
        console.log('[FCM] Firebase Admin (business) инициализлагдлаа');
      }
    }

    return { consumer: consumerMessaging, business: businessMessaging };
  } catch (err) {
    console.warn('[FCM] Firebase Admin алдаа:', err.message);
    return { consumer: null, business: null };
  }
}

/** Phone auth verifyIdToken — default (consumer) төсөл */
export async function getFirebaseAdmin() {
  const { consumer } = await ensureFirebaseMessaging();
  if (!consumer) return null;
  return fb;
}

/**
 * @param {'consumer'|'business'} [fcmApp]
 */
export async function sendFcmMessage(token, notification, data = {}, fcmApp = 'consumer') {
  const { consumer, business } = await ensureFirebaseMessaging();
  const messaging = fcmApp === 'business' && business != null ? business : consumer;
  if (!messaging) return { success: false, error: 'Firebase not configured' };
  try {
    const msg = {
      notification: { title: notification.title, body: notification.body || '' },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      token,
      android: { priority: 'high', notification: { channelId: 'qtime_notifications' } },
    };
    const id = await messaging.send(msg);
    return { success: true, messageId: id };
  } catch (err) {
    if (token && isStaleFcmTokenError(err)) {
      try {
        const { count } = await prisma.userDevice.deleteMany({ where: { fcmToken: token } });
        if (count > 0) console.warn('[FCM] removed stale device token from DB');
      } catch (e) {
        console.warn('[FCM] prune token:', e.message);
      }
    } else {
      console.error('[FCM] send error:', err.message);
    }
    return { success: false, error: err.message };
  }
}