import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

function clampDays(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(90, Math.max(1, n));
}

router.get('/summary', async (_req, res) => {
  try {
    const [users, today, week, eventsToday] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE is_active = true`),
      pool.query(
        `SELECT COUNT(DISTINCT username)::int AS n FROM usage_events
         WHERE created_at >= date_trunc('day', NOW())`
      ),
      pool.query(
        `SELECT COUNT(DISTINCT username)::int AS n FROM usage_events
         WHERE created_at >= NOW() - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM usage_events
         WHERE created_at >= date_trunc('day', NOW())`
      ),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers: users.rows[0].n,
        activeToday: today.rows[0].n,
        active7d: week.rows[0].n,
        eventsToday: eventsToday.rows[0].n,
      },
    });
  } catch (err) {
    logger.error('Reports summary error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/daily', async (req, res) => {
  try {
    const days = clampDays(req.query.days, 14);
    // generate_series fills days with zero activity so the chart has no gaps.
    const result = await pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(e.active_users, 0)::int AS "activeUsers",
              COALESCE(e.events, 0)::int AS events
       FROM generate_series(
              date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day',
              date_trunc('day', NOW()),
              INTERVAL '1 day'
            ) AS d(day)
       LEFT JOIN (
         SELECT date_trunc('day', created_at) AS day,
                COUNT(DISTINCT username) AS active_users,
                COUNT(*) AS events
         FROM usage_events
         WHERE created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day'
         GROUP BY 1
       ) e ON e.day = d.day
       ORDER BY d.day`,
      [days]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    logger.error('Reports daily error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/features', async (req, res) => {
  try {
    const days = clampDays(req.query.days, 30);
    // Only features that were actually used show up (GROUP BY), per design:
    // unused tools must not clutter the dashboard.
    const result = await pool.query(
      `SELECT feature, COUNT(*)::int AS count,
              COUNT(DISTINCT username)::int AS users
       FROM usage_events
       WHERE created_at >= NOW() - ($1::int || ' days')::interval
       GROUP BY feature
       ORDER BY count DESC
       LIMIT 20`,
      [days]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    logger.error('Reports features error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
