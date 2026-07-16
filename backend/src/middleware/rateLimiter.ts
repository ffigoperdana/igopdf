import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config/index.js';

// Normalize req.ip into a stable rate-limit key. IPv4 (and IPv4-mapped IPv6)
// pass through as-is; bare IPv6 is truncated to its first four groups — a
// best-effort /64-ish bucket (compressed "::" forms aren't expanded, so it can
// under-bucket, never over-block). This LAN app is IPv4-only in practice.
function ipKey(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  return ip;
}

export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    success: false,
    error: 'Too many requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const authenticatedUserKey = (req: Request): string =>
  req.user?.id || ipKey(req);

export const compressionControlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authenticatedUserKey,
  message: {
    success: false,
    error: 'Too many compression status requests. Please wait a moment.',
    code: 'COMPRESSION_RATE_LIMITED',
  },
});

export const compressionUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authenticatedUserKey,
  message: {
    success: false,
    error: 'Too many upload chunks. Resume this upload in a few minutes.',
    code: 'COMPRESSION_UPLOAD_RATE_LIMITED',
  },
});

// Keyed by IP + username (not IP alone). Office users often reach the app
// through a shared address (misconfigured proxy XFF, NAT, future WAF), and a
// pure per-IP counter pools everyone's failures into one bucket — ten typos
// by colleagues would 429 someone logging in for the first time. Including the
// username isolates each account's failures. Brute force is still contained:
// each attempt must pass a CAPTCHA first, and the per-account DB lockout in
// routes/auth.ts blocks a username after MAX_LOGIN_ATTEMPTS failures no matter
// how many IPs the attacker rotates through.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => {
    // slice(0,150) mirrors the zod max(150) that hasn't run yet at limiter
    // time — without it a 10 MB "username" would sit in the MemoryStore as a
    // 10 MB map key for the whole window (memory-exhaustion vector).
    const username =
      typeof req.body?.username === 'string'
        ? req.body.username.trim().toLowerCase().slice(0, 150)
        : '';
    return `${ipKey(req)}|${username}`;
  },
  message: {
    success: false,
    error: 'Too many login attempts, please try again later',
    code: 'LOGIN_RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

export const captchaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'Too many CAPTCHA requests, please try again later',
    code: 'CAPTCHA_RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
