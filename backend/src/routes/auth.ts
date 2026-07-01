import { Router } from 'express';
import { z } from 'zod';
import { login, logout } from '../services/authService.js';
import { verifyCaptcha } from '../services/captchaService.js';
import { authMiddleware } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
import { sessionConfig } from '../config/session.js';
import { logger } from '../utils/logger.js';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(3).max(150),
  password: z.string().min(8),
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
