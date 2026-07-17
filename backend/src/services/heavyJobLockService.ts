import type { PoolClient } from 'pg';
import { pool } from '../config/database.js';

// Compression and DOCX/OCR are both memory-intensive. This session-scoped
// PostgreSQL lock is intentionally held for the entire external process.
// If a worker dies, PostgreSQL closes the connection and releases the lock.
const HEAVY_JOB_LOCK_KEY = 724092;

export async function tryAcquireHeavyJobLock(): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [HEAVY_JOB_LOCK_KEY]
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function releaseHeavyJobLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [HEAVY_JOB_LOCK_KEY]);
  } finally {
    client.release();
  }
}
