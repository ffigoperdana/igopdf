import { Router } from 'express';
import { z } from 'zod';
import {
  login,
  logout,
  getRecentLoginAttempts,
} from '../services/authService.js';
import { verifyCaptcha } from '../services/captchaService.js';
import { authMiddleware } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
import { sessionConfig } from '../config/session.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(3).max(150),
  // 6, not 8: AD/WiFi passwords set by the domain policy can be shorter than
  // the local-account policy; login must accept whatever the directory allows.
  password: z.string().min(6),
  captchaToken: z.string().uuid(),
  captchaAnswer: z.string().min(1),
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: validation.error.issues,
      });
      return;
    }

    const { username, password, captchaToken, captchaAnswer } = validation.data;

    const captchaValid = await verifyCaptcha(captchaToken, captchaAnswer);
    if (!captchaValid) {
      res.status(400).json({
        success: false,
        error: 'Invalid or expired CAPTCHA',
        code: 'CAPTCHA_INVALID',
      });
      return;
    }

    const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Per-account lockout. The per-IP loginLimiter can't see usernames and
    // skips successful requests, so on its own it barely slows a targeted
    // guess against one account (and would let each failed LDAP bind hit AD).
    // Block once too many recent failures accrue for this username; a
    // successful login clears the counter (see authService.login).
    const recentFailures = await getRecentLoginAttempts(
      username,
      config.auth.lockoutMinutes
    );
    if (recentFailures.count >= config.auth.maxLoginAttempts) {
      res.status(429).json({
        success: false,
        error: `Too many failed login attempts. Try again in ${config.auth.lockoutMinutes} minutes.`,
        code: 'ACCOUNT_LOCKED',
      });
      return;
    }

    const result = await login(username, password, ipAddress, userAgent);

    if (!result.success || !result.session) {
      res.status(401).json({
        success: false,
        error: result.error || 'Login failed',
      });
      return;
    }

    const session = result.session as unknown as { token: string };
    res.cookie(sessionConfig.cookieName, session.token, sessionConfig.cookieOptions);

    logger.info('Login successful', { username, userId: result.user?.id });

    res.json({
      success: true,
      data: {
        user: result.user,
      },
      message: 'Login successful',
    });
  } catch (err) {
    logger.error('Login error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.cookies[sessionConfig.cookieName];
    if (token) {
      await logout(token);
    }

    res.clearCookie(sessionConfig.cookieName);
    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (err) {
    logger.error('Logout error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user,
    },
  });
});

export default router;
