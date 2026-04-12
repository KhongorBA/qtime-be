import { prisma } from '../config/db.js';
import { verifyJwt } from '../utils/jwtHelper.js';

const parseCookieValue = (cookieHeader, name) => {
  if (!cookieHeader) return null;
  const target = `${name}=`;
  const parts = String(cookieHeader).split(';');
  for (const raw of parts) {
    const part = raw.trim();
    if (part.startsWith(target)) {
      return decodeURIComponent(part.slice(target.length));
    }
  }
  return null;
};

export const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    token = parseCookieValue(req.headers.cookie, process.env.AUTH_COOKIE_NAME || 'bookez_at');
  }
  if (!token) {
    return res.status(401).json({ message: 'Not authorized' });
  }
  try {
    const decoded = verifyJwt(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, name: true, email: true, role: true, phone: true, avatar: true }
    });
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Not authorized' });
  }
};

export const optionalAuth = async (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    token = parseCookieValue(req.headers.cookie, process.env.AUTH_COOKIE_NAME || 'bookez_at');
  }
  if (token) {
    try {
      const decoded = verifyJwt(token);
      req.user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, name: true, email: true, role: true }
      });
    } catch {}
  }
  next();
};
