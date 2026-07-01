import { Router } from 'express';
import { generateCaptcha } from '../services/captchaService.js';
import { captchaLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.get('/', captchaLimiter, async (_req, res) => {
  try {
    const captcha = await generateCaptcha();

    res.json({
      success: true,
      data: {
        token: captcha.token,
        svg: captcha.svg,
      },
    });
  } catch (err) {
    logger.error('CAPTCHA generation error', err);
    res.status(500).json({
      success: false,
      error: 'Failed to generate CAPTCHA',
    });
  }
});

export default router;
