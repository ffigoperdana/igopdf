import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authMiddleware);

const trackSchema = z.object({
  feature: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
});

// Fire-and-forget beacon from tool pages; feeds the admin Reports dashboard.
router.post('/track', async (req, res) => {
  try {
    const validation = trackSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ success: false, error: 'Invalid input' });
      return;
    }

    await pool.query(
      `INSERT INTO usage_events (user_id, username, feature)
       VALUES ($1, $2, $3)`,
      [req.user!.id, req.user!.username, validation.data.feature]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('Usage track error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
