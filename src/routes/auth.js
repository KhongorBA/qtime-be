import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { getPublicKeyPem, decryptCredentials } from '../utils/rsaHelper.js';
import { getFirebaseAdmin } from '../utils/firebaseAdmin.js';
import { signJwt, verifyJwt } from '../utils/jwtHelper.js';
import { sendOtpNotification } from '../utils/notifyOtp.js';

export const authRoutes = express.Router();

const generateToken = (id) =>
  signJwt({ id }, process.env.JWT_EXPIRES_IN || '7d');

const authCookieName = process.env.AUTH_COOKIE_NAME || 'bookez_at';
const shouldUseSecureCookie = () =>
  process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const authCookieOptions = () => {
  const secure = shouldUseSecureCookie();
  const sameSite = secure ? 'none' : (process.env.COOKIE_SAME_SITE || 'lax');
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
};
const setAuthCookie = (res, token) => {
  const opts = authCookieOptions();
  const domain = process.env.COOKIE_DOMAIN;
  if (domain && domain.trim()) opts.domain = domain.trim();
  res.cookie(authCookieName, token, opts);
};

const generateSignupVerificationToken = ({ channel, destination }) =>
  signJwt({ channel, destination, purpose: 'signup_verify' }, '30m');

const otpChannelValues = ['phone', 'email'];
const otpPurposeValues = ['signup', 'login', 'password_change'];

const normalizePhone = (v) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  let compact = raw.replace(/[\s\-()]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (compact.startsWith('+')) return compact;
  if (compact.startsWith('976') && compact.length >= 11) return `+${compact}`;
  // Дотоод дугаар 0XXXXXXXX → +976XXXXXXXX
  if (/^0\d{8}$/.test(compact)) return `+976${compact.slice(1)}`;
  if (/^\d{8}$/.test(compact)) return `+976${compact}`;
  return compact;
};
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

const normalizeDestination = (channel, destination) => {
  if (channel === 'phone') return normalizePhone(destination);
  return normalizeEmail(destination);
};

/** DB-д янз бүрийн форматаар хадгалагдсан утсыг (8 орон, +976, 976, гэх мэт) нэг дор хайна */
const collectPhoneLookupValues = (raw) => {
  const loginTrim = String(raw || '').trim();
  if (!loginTrim) return [];
  const set = new Set();
  const compact = loginTrim.replace(/[\s\-()]/g, '');
  const normalized = normalizePhone(loginTrim);

  if (loginTrim.includes('@')) {
    set.add(loginTrim);
    if (normalized && normalized !== loginTrim) set.add(normalized);
    return [...set];
  }

  set.add(loginTrim);
  set.add(compact);
  if (normalized) set.add(normalized);

  const digits = compact.replace(/\D/g, '');
  if (digits.length >= 8) {
    const last8 = digits.slice(-8);
    set.add(last8);
    set.add(`976${last8}`);
    set.add(`+976${last8}`);
    if (digits.length >= 11 && digits.startsWith('976')) {
      set.add(digits);
      set.add(`+${digits}`);
    }
  }

  return [...set].filter(Boolean);
};

/** Нэвтрэх + нууц сэргээх — ижил утасны хувилбарууд */
const buildUserLookupOrConditions = (raw) => {
  const loginTrim = String(raw || '').trim();
  if (!loginTrim) return [];
  const phones = collectPhoneLookupValues(raw);
  return [
    { email: { equals: loginTrim, mode: 'insensitive' } },
    { loginName: loginTrim },
    ...phones.map((p) => ({ phone: p })),
  ];
};

const generateOtpCode = () => String(Math.floor(100000 + Math.random() * 900000));
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_REQUESTS_PER_WINDOW = 5;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const OTP_IP_MAX_REQUESTS_PER_HOUR = 20;
const OTP_IP_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttemptStore = new Map();

const normalizeDeviceId = (value) => {
  const v = String(value || '').trim();
  return v ? v.slice(0, 160) : null;
};

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

const loginAttemptKey = (ip, loginName) => `${ip}:${String(loginName || '').trim().toLowerCase()}`;

const registerLoginFailure = (key) => {
  const now = Date.now();
  const current = loginAttemptStore.get(key);
  if (!current || now > current.windowStart + LOGIN_WINDOW_MS) {
    loginAttemptStore.set(key, { count: 1, windowStart: now });
    return 1;
  }
  current.count += 1;
  loginAttemptStore.set(key, current);
  return current.count;
};

const resolveBusinessRoleForUser = async (userId) => {
  const membership = await prisma.businessMember.findFirst({
    where: { userId, status: 'approved' },
    orderBy: { updatedAt: 'desc' }
  });
  if (!membership) return null;
  if (membership.role === 'manager') return 'manager';
  if (membership.role === 'staff') return 'staff';
  return 'business_owner';
};

authRoutes.post(
  '/request-otp',
  [
    body('channel').isIn(otpChannelValues).withMessage('channel must be phone or email'),
    body('destination').trim().notEmpty().withMessage('destination is required'),
    body('purpose').optional().isIn(otpPurposeValues),
    body('deviceId').optional().isString().isLength({ min: 8, max: 160 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const channel = req.body.channel;
      const destination = normalizeDestination(channel, req.body.destination);
      const purpose = req.body.purpose || 'signup';
      const deviceId = normalizeDeviceId(req.body.deviceId || req.headers['x-device-id']);
      const ipAddress = getClientIp(req);
      const now = new Date();
      const cooldownAfter = new Date(now.getTime() - OTP_COOLDOWN_MS);
      const windowStart = new Date(now.getTime() - OTP_REQUEST_WINDOW_MS);
      const ipWindowStart = new Date(now.getTime() - OTP_IP_WINDOW_MS);

      const [lastRequest, requestCount, ipRequestCount] = await Promise.all([
        prisma.otpVerification.findFirst({
          where: { channel, destination, purpose, createdAt: { gte: cooldownAfter } },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.otpVerification.count({
          where: { channel, destination, purpose, createdAt: { gte: windowStart } }
        }),
        prisma.otpVerification.count({
          where: { purpose, ipAddress, createdAt: { gte: ipWindowStart } }
        })
      ]);

      if (lastRequest) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((OTP_COOLDOWN_MS - (now.getTime() - lastRequest.createdAt.getTime())) / 1000)
        );
        return res.status(429).json({
          message: `OTP дахин авахын тулд ${retryAfterSeconds} сек хүлээнэ үү`,
          retryAfterSeconds
        });
      }
      if (requestCount >= OTP_MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({
          message: 'OTP авах оролдлогын хязгаарт хүрлээ. Түр хүлээгээд дахин оролдоно уу.'
        });
      }
      if (ipRequestCount >= OTP_IP_MAX_REQUESTS_PER_HOUR) {
        return res.status(429).json({
          message: 'Энэ IP-аас хэт олон OTP хүсэлт илгээгдсэн байна. Дараа дахин оролдоно уу.'
        });
      }

      const code = generateOtpCode();
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await prisma.otpVerification.create({
        data: {
          channel,
          destination,
          purpose,
          codeHash,
          expiresAt,
          deviceId,
          ipAddress
        }
      });

      // Send OTP notification (non-blocking — don't fail request on delivery error)
      sendOtpNotification(channel, destination, code).catch((err) =>
        console.error('[OTP] Notification delivery failed:', err.message)
      );

      const payload = { message: 'OTP sent' };
      if (process.env.NODE_ENV !== 'production') payload.otp = code;
      res.status(201).json(payload);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.post(
  '/verify-otp',
  [
    body('channel').isIn(otpChannelValues).withMessage('channel must be phone or email'),
    body('destination').trim().notEmpty().withMessage('destination is required'),
    body('code').trim().isLength({ min: 4, max: 8 }),
    body('purpose').optional().isIn(otpPurposeValues),
    body('deviceId').optional().isString().isLength({ min: 8, max: 160 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const channel = req.body.channel;
      const destination = normalizeDestination(channel, req.body.destination);
      const code = String(req.body.code).trim();
      const purpose = req.body.purpose || 'signup';
      const deviceId = normalizeDeviceId(req.body.deviceId || req.headers['x-device-id']);

      const otp = await prisma.otpVerification.findFirst({
        where: {
          channel,
          destination,
          purpose,
          usedAt: null,
          OR: [
            { blockedUntil: null },
            { blockedUntil: { lte: new Date() } }
          ],
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' }
      });
      if (!otp) return res.status(400).json({ message: 'OTP буруу эсвэл хугацаа дууссан' });
      if (otp.deviceId && deviceId && otp.deviceId !== deviceId) {
        return res.status(400).json({ message: 'OTP-ийг өөр төхөөрөмжөөс баталгаажуулах боломжгүй' });
      }
      if (otp.failedAttempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        return res.status(429).json({ message: 'OTP оролдлогын лимит хэтэрсэн. Шинэ OTP авна уу.' });
      }

      const codeMatch = await bcrypt.compare(code, otp.codeHash);
      if (!codeMatch) {
        const failedAttempts = otp.failedAttempts + 1;
        await prisma.otpVerification.update({
          where: { id: otp.id },
          data: {
            failedAttempts,
            blockedUntil: failedAttempts >= OTP_MAX_VERIFY_ATTEMPTS
              ? new Date(Date.now() + 15 * 60 * 1000)
              : otp.blockedUntil
          }
        });
        if (failedAttempts >= OTP_MAX_VERIFY_ATTEMPTS) {
          return res.status(429).json({ message: 'OTP буруу. Дээд оролдлогын тоо дууссан тул дахин OTP авна уу.' });
        }
        return res.status(400).json({ message: `OTP буруу. Үлдсэн оролдлого: ${OTP_MAX_VERIFY_ATTEMPTS - failedAttempts}` });
      }

      await prisma.otpVerification.update({
        where: { id: otp.id },
        data: { usedAt: new Date(), blockedUntil: null }
      });

      const verificationToken = generateSignupVerificationToken({ channel, destination });
      res.status(200).json({
        message: 'OTP verified',
        verificationToken
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.post(
  '/verify-firebase-otp',
  [
    body('channel').isIn(['phone']).withMessage('firebase OTP currently supports phone only'),
    body('destination').trim().notEmpty().withMessage('destination is required'),
    body('firebaseIdToken').trim().notEmpty().withMessage('firebaseIdToken is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const channel = req.body.channel;
      const destination = normalizeDestination(channel, req.body.destination);
      const firebaseIdToken = String(req.body.firebaseIdToken).trim();

      const fb = await getFirebaseAdmin();
      if (!fb) {
        return res.status(503).json({ message: 'Firebase auth тохируулагдаагүй байна' });
      }

      const decoded = await fb.auth().verifyIdToken(firebaseIdToken, true);
      const firebasePhone = normalizePhone(decoded.phone_number || '');
      if (!firebasePhone || firebasePhone !== destination) {
        return res.status(400).json({ message: 'Firebase OTP баталгаажуулсан дугаар зөрж байна' });
      }

      const verificationToken = generateSignupVerificationToken({ channel, destination });
      return res.status(200).json({ message: 'Firebase OTP verified', verificationToken });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.post(
  '/register-business',
  [
    body('verificationToken').trim().notEmpty().withMessage('verificationToken required'),
    body('name').trim().notEmpty().withMessage('name is required'),
    body('credentials').notEmpty().withMessage('credentials (password or cipher) is required'),
    body('phone').trim().notEmpty().withMessage('phone is required'),
    body('email').trim().isEmail().withMessage('valid email is required'),
    body('loginName').optional().trim(),
    body('role').optional().isIn(['business', 'business_owner'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      let decoded;
      try {
        decoded = verifyJwt(req.body.verificationToken);
      } catch (_) {
        return res.status(400).json({ message: 'verificationToken хүчингүй эсвэл хугацаа дууссан' });
      }
      if (decoded.purpose !== 'signup_verify') {
        return res.status(400).json({ message: 'verificationToken буруу төрөлтэй' });
      }

      const channel = decoded.channel;
      const destination = decoded.destination;
      const name = String(req.body.name).trim();
      const desiredRole = req.body.role === 'business' ? 'business_owner' : (req.body.role || 'business_owner');
      const loginName = req.body.loginName?.trim() || null;
      const phoneValue = normalizePhone(req.body.phone);
      const emailValue = normalizeEmail(req.body.email);

      if (!phoneValue || !emailValue) {
        return res.status(400).json({ message: 'Email болон phone заавал оруулна' });
      }
      if (channel === 'phone' && destination !== phoneValue) {
        return res.status(400).json({ message: 'OTP баталгаажуулсан phone болон оруулсан phone зөрж байна' });
      }
      if (channel === 'email' && destination !== emailValue) {
        return res.status(400).json({ message: 'OTP баталгаажуулсан email болон оруулсан email зөрж байна' });
      }

      let password = req.body.credentials;
      const useCipher = process.env.AUTH_USE_CIPHER !== 'false';
      if (useCipher && /^[A-Za-z0-9+/]+=*$/.test(password) && password.length > 200) {
        const decrypted = decryptCredentials(password);
        if (decrypted) password = decrypted;
      }
      if (String(password).length < 6) {
        return res.status(400).json({ message: 'Нууц үг хамгийн багадаа 6 тэмдэгт' });
      }

      const existing = await prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: emailValue, mode: 'insensitive' } },
            { phone: phoneValue },
            ...(loginName ? [{ loginName }] : [])
          ]
        }
      });
      if (existing) {
        if (
          normalizeEmail(existing.email) === emailValue &&
          normalizePhone(existing.phone) === phoneValue
        ) {
          const token = generateToken(existing.id);
          setAuthCookie(res, token);
          return res.status(200).json({
            id: existing.id,
            name: existing.name,
            email: existing.email,
            phone: existing.phone,
            role: existing.role,
            token,
            message: 'Хэрэглэгч өмнө нь үүссэн байна. Нэвтрэлт амжилттай сэргээгдлээ.'
          });
        }
        return res.status(400).json({ message: 'Email эсвэл phone аль хэдийн ашиглагдсан байна' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          name,
          email: emailValue,
          password: passwordHash,
          phone: phoneValue,
          loginName,
          role: desiredRole
        }
      });

      const token = generateToken(user.id);
      setAuthCookie(res, token);
      res.status(201).json({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        token
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// backward compatibility
authRoutes.post('/verify-otp-signup', (req, res) => {
  res.status(410).json({ message: 'Use /auth/verify-otp then /auth/register-business' });
});

authRoutes.post(
  '/register',
  [
    body('fullName').trim().notEmpty().withMessage('fullName (нэр) is required'),
    body('phone').trim().notEmpty().withMessage('phone is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('loginname').optional().trim(),
    body('email').optional().isEmail(),
    body('birthDate').optional().trim(),
    body('gender').optional().isIn(['male', 'female', 'other'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { fullName, phone, password, loginname, email, birthDate, gender } = req.body;
      const phoneClean = String(phone).replace(/\s/g, '').trim();

      const emailVal = email && email.trim()
        ? email.trim()
        : `p_${phoneClean.replace(/\D/g, '')}@bookez.user`;

      const existsEmail = await prisma.user.findUnique({ where: { email: emailVal } });
      if (existsEmail) return res.status(400).json({ message: 'Имэйл эсвэл утас аль хэдийн бүртгэлтэй' });

      if (loginname) {
        const existsLogin = await prisma.user.findUnique({ where: { loginName: loginname.trim() } });
        if (existsLogin) return res.status(400).json({ message: 'Нэвтрэх нэр завшсан' });
      }

      const existsPhone = await prisma.user.findFirst({ where: { phone: phoneClean } });
      if (existsPhone) return res.status(400).json({ message: 'Утасны дугаар аль хэдийн бүртгэлтэй' });

      const hashedPassword = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          name: fullName,
          email: emailVal,
          password: hashedPassword,
          phone: phoneClean,
          loginName: loginname?.trim() || null,
          role: 'customer'
        }
      });

      res.status(201).json({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        loginName: user.loginName,
        role: user.role,
        token: generateToken(user.id)
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.get('/public-key', (req, res) => {
  try {
    const publicKey = getPublicKeyPem();
    res.json({ publicKey });
  } catch (err) {
    res.status(500).json({ message: 'Failed to get public key' });
  }
});

authRoutes.post(
  '/login',
  [
    body('loginName').trim().notEmpty().withMessage('loginName (email or phone) is required'),
    body('credentials').notEmpty().withMessage('credentials (password or cipher) is required'),
    body('deviceId').optional().isString().isLength({ min: 8, max: 160 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { loginName, credentials } = req.body;
      let password = credentials;
      const ip = getClientIp(req);
      const key = loginAttemptKey(ip, loginName);
      const existingAttempt = loginAttemptStore.get(key);
      if (existingAttempt && Date.now() <= existingAttempt.windowStart + LOGIN_WINDOW_MS && existingAttempt.count >= LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({ message: 'Хэт олон буруу нэвтрэх оролдлого. Түр хүлээгээд дахин оролдоно уу.' });
      }

      // If credentials look like base64 RSA cipher, decrypt first
      const useCipher = process.env.AUTH_USE_CIPHER !== 'false';
      if (useCipher && /^[A-Za-z0-9+/]+=*$/.test(credentials) && credentials.length > 200) {
        const decrypted = decryptCredentials(credentials);
        if (decrypted) password = decrypted;
      }

      const loginTrim = loginName.trim();
      const phoneOr = collectPhoneLookupValues(loginName).map((p) => ({ phone: p }));
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: loginTrim, mode: 'insensitive' } },
            { loginName: loginTrim },
            ...phoneOr,
          ],
        },
      });

      if (!user) {
        registerLoginFailure(key);
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        registerLoginFailure(key);
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      loginAttemptStore.delete(key);

      const businessRole = await resolveBusinessRoleForUser(user.id);
      const token = generateToken(user.id);
      setAuthCookie(res, token);
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: businessRole || user.role,
        token
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.get('/me', protect, async (req, res) => {
  try {
    const businessRole = await resolveBusinessRoleForUser(req.user.id);
    const role = businessRole || req.user.role;
    res.json({
      ...req.user,
      role,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

authRoutes.post('/logout', (req, res) => {
  const opts = authCookieOptions();
  const domain = process.env.COOKIE_DOMAIN;
  if (domain && domain.trim()) opts.domain = domain.trim();
  res.clearCookie(authCookieName, opts);
  res.json({ message: 'Logged out' });
});

authRoutes.get('/security-pin/status', protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { pinEnabled: true, biometricEnabled: true }
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

authRoutes.post(
  '/security-pin/setup',
  [
    body('pin')
      .trim()
      .matches(/^\d{4,6}$/)
      .withMessage('PIN must be 4-6 digits'),
    body('biometricEnabled').optional().isBoolean()
  ],
  protect,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const pinHash = await bcrypt.hash(String(req.body.pin), 10);
      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          securityPinHash: pinHash,
          pinEnabled: true,
          biometricEnabled: !!req.body.biometricEnabled
        }
      });
      res.json({ success: true, pinEnabled: true, biometricEnabled: !!req.body.biometricEnabled });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.post(
  '/security-pin/verify',
  [
    body('pin')
      .trim()
      .matches(/^\d{4,6}$/)
      .withMessage('PIN must be 4-6 digits')
  ],
  protect,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { securityPinHash: true, pinEnabled: true }
      });
      if (!user || !user.pinEnabled || !user.securityPinHash) {
        return res.status(400).json({ message: 'PIN тохируулаагүй байна' });
      }
      const ok = await bcrypt.compare(String(req.body.pin), user.securityPinHash);
      if (!ok) return res.status(401).json({ message: 'PIN буруу байна' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

authRoutes.patch(
  '/security-pin/biometric',
  [body('enabled').isBoolean().withMessage('enabled must be boolean')],
  protect,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const user = await prisma.user.update({
        where: { id: req.user.id },
        data: { biometricEnabled: !!req.body.enabled },
        select: { pinEnabled: true, biometricEnabled: true }
      });
      res.json(user);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// Нэвтэрсэн хэрэглэгч нууц үг солих
authRoutes.post(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('currentPassword required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Нууц үг хамгийн багадаа 6 тэмдэгт'),
  ],
  protect,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { currentPassword, newPassword, otpCode } = req.body;
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { password: true, email: true },
      });
      if (!user) return res.status(404).json({ message: 'User not found' });
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) return res.status(401).json({ message: 'Одоогийн нууц үг буруу байна' });

      // Email OTP шалгалт
      if (!otpCode) return res.status(400).json({ message: 'OTP код шаардлагатай' });
      if (!user.email) return res.status(400).json({ message: 'Бүртгэлтэй и-мэйл байхгүй' });
      const otp = await prisma.otpVerification.findFirst({
        where: {
          destination: user.email,
          purpose: 'password_change',
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!otp) return res.status(400).json({ message: 'OTP буруу эсвэл хугацаа дууссан' });
      const codeMatch = await bcrypt.compare(String(otpCode), otp.codeHash);
      if (!codeMatch) return res.status(400).json({ message: 'OTP буруу байна' });
      await prisma.otpVerification.update({ where: { id: otp.id }, data: { usedAt: new Date() } });

      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({
        where: { id: req.user.id },
        data: { password: hashedPassword },
      });
      res.json({ message: 'Нууц үг амжилттай шинэчлэгдлээ' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// Нууц үг мартсан - имэйл эсвэл утас оруулаад reset token үүсгэнэ
authRoutes.post(
  '/forgot-password',
  [
    body('identifier').optional().trim(),
    body('email').optional().trim().isEmail(),
    body('phone').optional().trim(),
  ],
  async (req, res) => {
    try {
      const { email, phone, identifier } = req.body;
      const idRaw = identifier ? String(identifier).trim() : '';
      const emailTrim = email?.trim() || '';
      const phoneClean = phone ? String(phone).replace(/\s/g, '').trim() : '';

      const seeds = [];
      if (idRaw) seeds.push(idRaw);
      if (!idRaw) {
        if (emailTrim) seeds.push(emailTrim);
        if (phoneClean) seeds.push(phoneClean);
      }
      const uniqueSeeds = [...new Set(seeds.filter(Boolean))];

      if (uniqueSeeds.length === 0) {
        return res.status(400).json({ message: 'Имэйл эсвэл утасны дугаар оруулна уу' });
      }

      const orConditions = [];
      for (const s of uniqueSeeds) {
        orConditions.push(...buildUserLookupOrConditions(s));
      }

      const user = await prisma.user.findFirst({
        where: { OR: orConditions },
      });
      if (!user) {
        return res.status(404).json({ message: 'Хэрэглэгч олдсонгүй' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 цаг
      await prisma.passwordResetToken.create({
        data: { userId: user.id, token, expiresAt },
      });
      const returnToken = process.env.FORGOT_PASSWORD_RETURN_TOKEN === 'true';
      res.json({
        message: 'Нууц үг сэргээх холбоос илгээгдсэн',
        ...(returnToken ? { resetToken: token } : {}),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// Нууц үг сэргээх - token + шинэ нууц үг
authRoutes.post(
  '/reset-password',
  [
    body('token').trim().notEmpty().withMessage('Token шаардлагатай'),
    body('newPassword').isLength({ min: 6 }).withMessage('Нууц үг хамгийн багадаа 6 тэмдэгт'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { token, newPassword } = req.body;
      const record = await prisma.passwordResetToken.findUnique({
        where: { token },
        include: { user: true },
      });
      if (!record || record.usedAt || new Date() > record.expiresAt) {
        return res.status(400).json({ message: 'Токен хугацаа дууссан эсвэл буруу' });
      }
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: { password: hashedPassword },
        }),
        prisma.passwordResetToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
      ]);
      res.json({ message: 'Нууц үг амжилттай шинэчлэгдлээ' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);
