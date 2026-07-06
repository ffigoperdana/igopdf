import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

const REPORT_TIME_ZONE = process.env.REPORT_TIME_ZONE || 'Asia/Jakarta';

function clampDays(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(90, Math.max(1, n));
}

function parseMonth(raw: unknown): string | null {
  const value = String(raw ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return null;
  return value;
}

function formatMonthLabel(month: string): string {
  const [year, monthNum] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNum - 1, 1)));
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

router.get('/months', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT to_char(month_start, 'YYYY-MM') AS month,
              COUNT(*)::int AS events,
              COUNT(DISTINCT username)::int AS "activeUsers"
       FROM (
         SELECT date_trunc('month', created_at AT TIME ZONE $1)::date AS month_start,
                username
         FROM usage_events
       ) monthly_events
       GROUP BY month_start
       ORDER BY month_start DESC`,
      [REPORT_TIME_ZONE]
    );

    res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...row,
        label: formatMonthLabel(row.month),
      })),
    });
  } catch (err) {
    logger.error('Reports months error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const month = parseMonth(req.query.month);
    if (!month) {
      res.status(400).json({
        success: false,
        error: 'Invalid month. Use YYYY-MM format.',
      });
      return;
    }

    const monthStart = `${month}-01`;
    const [summary, daily, weekly, features] = await Promise.all([
      pool.query(
        `WITH bounds AS (
           SELECT $1::date AS start_date,
                  ($1::date + INTERVAL '1 month') AS end_date
         ),
         events AS (
           SELECT username,
                  feature,
                  created_at AT TIME ZONE $2 AS local_created_at
           FROM usage_events, bounds
           WHERE created_at AT TIME ZONE $2 >= bounds.start_date
             AND created_at AT TIME ZONE $2 < bounds.end_date
         )
         SELECT (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS "totalUsers",
                COUNT(DISTINCT username)::int AS "monthlyActiveUsers",
                COUNT(*)::int AS "totalActivities",
                COUNT(DISTINCT date_trunc('day', local_created_at))::int AS "daysWithActivity"
         FROM events`,
        [monthStart, REPORT_TIME_ZONE]
      ),
      pool.query(
        `WITH bounds AS (
           SELECT $1::date AS start_date,
                  ($1::date + INTERVAL '1 month') AS end_date
         ),
         days AS (
           SELECT day::date
           FROM bounds,
                generate_series(
                  bounds.start_date,
                  bounds.end_date - INTERVAL '1 day',
                  INTERVAL '1 day'
                ) AS generated_days(day)
         ),
         events AS (
           SELECT username,
                  feature,
                  created_at AT TIME ZONE $2 AS local_created_at
           FROM usage_events, bounds
           WHERE created_at AT TIME ZONE $2 >= bounds.start_date
             AND created_at AT TIME ZONE $2 < bounds.end_date
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
                COUNT(events.feature)::int AS events,
                COALESCE(COUNT(DISTINCT events.username), 0)::int AS "activeUsers"
         FROM days
         LEFT JOIN events ON date_trunc('day', events.local_created_at)::date = days.day
         GROUP BY days.day
         ORDER BY days.day`,
        [monthStart, REPORT_TIME_ZONE]
      ),
      pool.query(
        `WITH bounds AS (
           SELECT $1::date AS start_date,
                  ($1::date + INTERVAL '1 month') AS end_date
         ),
         week_ranges AS (
           SELECT week_start::date AS week_start,
                  LEAST(
                    (week_start + INTERVAL '6 days')::date,
                    (bounds.end_date - INTERVAL '1 day')::date
                  ) AS week_end
           FROM bounds,
                generate_series(
                  bounds.start_date,
                  bounds.end_date - INTERVAL '1 day',
                  INTERVAL '7 days'
                ) AS generated_weeks(week_start)
         ),
         events AS (
           SELECT username,
                  feature,
                  created_at AT TIME ZONE $2 AS local_created_at
           FROM usage_events, bounds
           WHERE created_at AT TIME ZONE $2 >= bounds.start_date
             AND created_at AT TIME ZONE $2 < bounds.end_date
         )
         SELECT to_char(week_ranges.week_start, 'YYYY-MM-DD') AS "weekStart",
                to_char(week_ranges.week_end, 'YYYY-MM-DD') AS "weekEnd",
                COUNT(events.feature)::int AS events,
                COALESCE(COUNT(DISTINCT events.username), 0)::int AS "activeUsers"
         FROM week_ranges
         LEFT JOIN events
           ON events.local_created_at::date >= week_ranges.week_start
          AND events.local_created_at::date <= week_ranges.week_end
         GROUP BY week_ranges.week_start, week_ranges.week_end
         ORDER BY week_ranges.week_start`,
        [monthStart, REPORT_TIME_ZONE]
      ),
      pool.query(
        `WITH bounds AS (
           SELECT $1::date AS start_date,
                  ($1::date + INTERVAL '1 month') AS end_date
         ),
         events AS (
           SELECT username,
                  feature,
                  created_at AT TIME ZONE $2 AS local_created_at
           FROM usage_events, bounds
           WHERE created_at AT TIME ZONE $2 >= bounds.start_date
             AND created_at AT TIME ZONE $2 < bounds.end_date
         )
         SELECT feature,
                COUNT(*)::int AS count,
                COUNT(DISTINCT username)::int AS users
         FROM events
         GROUP BY feature
         ORDER BY count DESC, feature ASC
         LIMIT 20`,
        [monthStart, REPORT_TIME_ZONE]
      ),
    ]);

    const dailyRows = daily.rows;
    const weeklyRows = weekly.rows;
    const summaryRow = summary.rows[0];
    const totalActivities = Number(summaryRow.totalActivities || 0);
    const avgDailyActiveUsers =
      dailyRows.length === 0
        ? 0
        : dailyRows.reduce((sum, row) => sum + Number(row.activeUsers || 0), 0) /
          dailyRows.length;
    const avgWeeklyActiveUsers =
      weeklyRows.length === 0
        ? 0
        : weeklyRows.reduce((sum, row) => sum + Number(row.activeUsers || 0), 0) /
          weeklyRows.length;

    res.json({
      success: true,
      data: {
        month,
        label: formatMonthLabel(month),
        generatedAt: new Date().toISOString(),
        timeZone: REPORT_TIME_ZONE,
        summary: {
          totalUsers: Number(summaryRow.totalUsers || 0),
          monthlyActiveUsers: Number(summaryRow.monthlyActiveUsers || 0),
          totalActivities,
          daysWithActivity: Number(summaryRow.daysWithActivity || 0),
          avgDailyActiveUsers: Number(avgDailyActiveUsers.toFixed(2)),
          avgWeeklyActiveUsers: Number(avgWeeklyActiveUsers.toFixed(2)),
          avgDailyActivities:
            dailyRows.length === 0
              ? 0
              : Number((totalActivities / dailyRows.length).toFixed(2)),
        },
        daily: dailyRows,
        weekly: weeklyRows,
        features: features.rows,
      },
    });
  } catch (err) {
    logger.error('Reports monthly error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
