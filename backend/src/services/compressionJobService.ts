import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm, rename, stat, statfs } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import path from 'node:path';
import { pool } from '../config/database.js';
import { config } from '../config/index.js';

export type CompressionMode = 'lossless' | 'balanced';
export type CompressionJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface CompressionJob {
  id: string;
  userId: string;
  inputBytes: number;
  mode: CompressionMode;
  status: CompressionJobStatus;
  errorCode: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}

export type CompressionUploadSlotStatus =
  | 'waiting'
  | 'ready'
  | 'uploading'
  | 'processing';

export interface CompressionUploadSlot {
  id: string;
  userId: string;
  mode: CompressionMode;
  status: CompressionUploadSlotStatus;
  jobId: string | null;
  inputBytes: number;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  queuePosition: number;
}

const JOB_FIELDS = `
  id,
  user_id AS "userId",
  input_bytes::text AS "inputBytes",
  mode,
  status,
  error_code AS "errorCode",
  cancel_requested AS "cancelRequested",
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  expires_at AS "expiresAt"
`;

function mapJob(row: Record<string, unknown>): CompressionJob {
  return {
    id: String(row.id),
    userId: String(row.userId),
    inputBytes: Number(row.inputBytes),
    mode: row.mode as CompressionMode,
    status: row.status as CompressionJobStatus,
    errorCode: row.errorCode ? String(row.errorCode) : null,
    cancelRequested: Boolean(row.cancelRequested),
    createdAt: new Date(String(row.createdAt)),
    startedAt: row.startedAt ? new Date(String(row.startedAt)) : null,
    completedAt: row.completedAt ? new Date(String(row.completedAt)) : null,
    expiresAt: new Date(String(row.expiresAt)),
  };
}

function mapUploadSlot(
  row: Record<string, unknown>,
  queuePosition: number
): CompressionUploadSlot {
  return {
    id: String(row.id),
    userId: String(row.userId),
    mode: row.mode as CompressionMode,
    status: row.status as CompressionUploadSlotStatus,
    jobId: row.jobId ? String(row.jobId) : null,
    inputBytes: Number(row.inputBytes || 0),
    createdAt: new Date(String(row.createdAt)),
    lastActivityAt: new Date(String(row.lastActivityAt)),
    expiresAt: new Date(String(row.expiresAt)),
    queuePosition,
  };
}

const UPLOAD_SLOT_FIELDS = `
  id,
  user_id AS "userId",
  mode,
  status,
  job_id AS "jobId",
  input_bytes::text AS "inputBytes",
  created_at AS "createdAt",
  last_activity_at AS "lastActivityAt",
  expires_at AS "expiresAt"
`;

async function synchronizeUploadQueue(client: PoolClient): Promise<void> {
  // The advisory lock makes slot admission deterministic even when two users
  // request the server queue at exactly the same time.
  await client.query('SELECT pg_advisory_xact_lock(724091)');
  const expired = await client.query<{ id: string }>(
    `DELETE FROM compression_upload_slots slots
     WHERE slots.expires_at <= NOW()
        OR EXISTS (
          SELECT 1
          FROM compression_jobs jobs
          WHERE jobs.id = slots.job_id
            AND jobs.status IN ('completed', 'failed', 'cancelled', 'expired')
        )
     RETURNING slots.id`
  );
  await Promise.all(expired.rows.map(({ id }) => removeTusUploadArtifacts(id)));

  const slots = await client.query<Record<string, unknown>>(
    `SELECT ${UPLOAD_SLOT_FIELDS}
     FROM compression_upload_slots
     ORDER BY created_at
     FOR UPDATE`
  );
  const first = slots.rows[0];
  if (first?.status === 'waiting') {
    await client.query(
      `UPDATE compression_upload_slots SET status = 'ready' WHERE id = $1`,
      [first.id]
    );
  }
}

async function withUploadQueueLock<T>(
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await synchronizeUploadQueue(client);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readUploadSlot(
  client: PoolClient,
  slotId: string,
  userId: string
): Promise<CompressionUploadSlot | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${UPLOAD_SLOT_FIELDS},
       (SELECT COUNT(*)::int FROM compression_upload_slots earlier
        WHERE earlier.created_at <= slots.created_at) AS "queuePosition"
     FROM compression_upload_slots slots
     WHERE id = $1 AND user_id = $2`,
    [slotId, userId]
  );
  if (!result.rows[0]) return null;
  return mapUploadSlot(result.rows[0], Number(result.rows[0].queuePosition));
}

export async function reserveCompressionUploadSlot(
  userId: string,
  mode: CompressionMode,
  inputBytes: number
): Promise<CompressionUploadSlot> {
  return withUploadQueueLock(async (client) => {
    const existingResult = await client.query<Record<string, unknown>>(
      `SELECT ${UPLOAD_SLOT_FIELDS}
       FROM compression_upload_slots
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );
    if (existingResult.rows[0]) {
      const existing = mapUploadSlot(existingResult.rows[0], 0);
      if (existing.mode !== mode || existing.inputBytes !== inputBytes) {
        throw new Error('ACTIVE_UPLOAD_EXISTS');
      }
      await client.query(
        `UPDATE compression_upload_slots
         SET last_activity_at = NOW(),
             expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
         WHERE id = $1`,
        [existing.id, config.compression.uploadIdleTimeoutMs]
      );
      const refreshed = await readUploadSlot(client, existing.id, userId);
      if (!refreshed) throw new Error('UPLOAD_SLOT_UNAVAILABLE');
      return refreshed;
    }

    const expiresAt = new Date(
      Date.now() + config.compression.uploadIdleTimeoutMs
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO compression_upload_slots (user_id, mode, input_bytes, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, mode, inputBytes, expiresAt]
    );
    let slot = await readUploadSlot(client, inserted.rows[0].id, userId);
    if (!slot) throw new Error('UPLOAD_SLOT_UNAVAILABLE');
    if (slot.queuePosition === 1 && slot.status === 'waiting') {
      await client.query(
        `UPDATE compression_upload_slots SET status = 'ready' WHERE id = $1`,
        [slot.id]
      );
      slot = await readUploadSlot(client, slot.id, userId);
      if (!slot) throw new Error('UPLOAD_SLOT_UNAVAILABLE');
    }
    return slot;
  });
}

export async function getCompressionUploadSlot(
  slotId: string,
  userId: string
): Promise<CompressionUploadSlot | null> {
  return withUploadQueueLock(async (client) => {
    await client.query(
      `UPDATE compression_upload_slots
       SET last_activity_at = NOW(),
           expires_at = CASE
             WHEN status = 'processing' THEN expires_at
             ELSE NOW() + ($3::bigint * INTERVAL '1 millisecond')
           END
       WHERE id = $1 AND user_id = $2`,
      [slotId, userId, config.compression.uploadIdleTimeoutMs]
    );
    return readUploadSlot(client, slotId, userId);
  });
}

export async function claimCompressionUploadSlot(
  slotId: string,
  userId: string,
  mode: CompressionMode,
  inputBytes: number
): Promise<CompressionUploadSlot | null> {
  return withUploadQueueLock(async (client) => {
    const slot = await readUploadSlot(client, slotId, userId);
    if (
      !slot ||
      slot.mode !== mode ||
      slot.inputBytes !== inputBytes ||
      slot.status !== 'ready' ||
      slot.queuePosition !== 1
    ) {
      return null;
    }
    await client.query(
      `UPDATE compression_upload_slots
       SET status = 'uploading', last_activity_at = NOW(),
           expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
       WHERE id = $1`,
      [slotId, config.compression.uploadIdleTimeoutMs]
    );
    return readUploadSlot(client, slotId, userId);
  });
}

export async function authorizeCompressionUpload(
  slotId: string,
  userId: string
): Promise<CompressionUploadSlot | null> {
  return withUploadQueueLock(async (client) => {
    const slot = await readUploadSlot(client, slotId, userId);
    if (!slot || !['uploading', 'processing'].includes(slot.status))
      return null;
    if (slot.status === 'uploading') {
      await client.query(
        `UPDATE compression_upload_slots
         SET last_activity_at = NOW(),
             expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
         WHERE id = $1 AND user_id = $2`,
        [slotId, userId, config.compression.uploadIdleTimeoutMs]
      );
    }
    return readUploadSlot(client, slotId, userId);
  });
}

export async function resetCompressionUploadSlot(
  slotId: string,
  userId: string
): Promise<CompressionUploadSlot | null> {
  const slot = await withUploadQueueLock(async (client) => {
    const result = await client.query(
      `UPDATE compression_upload_slots
       SET status = 'ready', last_activity_at = NOW(),
           expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
       WHERE id = $1 AND user_id = $2 AND status = 'uploading' AND job_id IS NULL`,
      [slotId, userId, config.compression.uploadIdleTimeoutMs]
    );
    if (result.rowCount !== 1) return null;
    return readUploadSlot(client, slotId, userId);
  });
  if (slot) await removeTusUploadArtifacts(slotId);
  return slot;
}

export async function attachCompressionUploadSlot(
  slotId: string,
  userId: string,
  jobId: string
): Promise<void> {
  await withUploadQueueLock(async (client) => {
    const result = await client.query(
      `UPDATE compression_upload_slots
       SET status = 'processing', job_id = $3,
           last_activity_at = NOW(),
           expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond')
       WHERE id = $1 AND user_id = $2 AND status = 'uploading'`,
      [
        slotId,
        userId,
        jobId,
        config.compression.jobTimeoutMs + config.compression.retentionMs,
      ]
    );
    if (result.rowCount !== 1) throw new Error('UPLOAD_SLOT_UNAVAILABLE');
  });
}

export async function releaseCompressionUploadSlot(
  slotId: string,
  userId: string
): Promise<void> {
  const removed = await withUploadQueueLock(async (client) => {
    const result = await client.query(
      `DELETE FROM compression_upload_slots
       WHERE id = $1 AND user_id = $2 AND job_id IS NULL`,
      [slotId, userId]
    );
    return result.rowCount === 1;
  });
  if (removed) await removeTusUploadArtifacts(slotId);
}

export function ensureCompressionStorage(): void {
  if (!existsSync(config.compression.jobsDir)) {
    mkdirSync(config.compression.jobsDir, { recursive: true, mode: 0o700 });
  }
  const incomingDir = path.join(config.compression.jobsDir, 'incoming');
  if (!existsSync(incomingDir)) {
    mkdirSync(incomingDir, { recursive: true, mode: 0o700 });
  }
  const uploadsDir = getTusUploadDirectory();
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  }
}

export function getTusUploadDirectory(): string {
  return path.join(config.compression.jobsDir, 'uploads');
}

export function getTusUploadPath(uploadId: string): string {
  return path.join(getTusUploadDirectory(), uploadId);
}

export async function removeTusUploadArtifacts(
  uploadId: string
): Promise<void> {
  await Promise.all([
    rm(getTusUploadPath(uploadId), { force: true }),
    rm(`${getTusUploadPath(uploadId)}.json`, { force: true }),
  ]);
}

export async function ensureCompressionDiskCapacity(
  inputBytes: number
): Promise<void> {
  ensureCompressionStorage();
  const filesystem = await statfs(config.compression.jobsDir);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = Math.max(
    config.compression.diskMinimumFreeBytes,
    inputBytes * config.compression.diskHeadroomMultiplier
  );
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error('INSUFFICIENT_STORAGE');
  }
}

export function getIncomingPath(uploadId: string): string {
  ensureCompressionStorage();
  return path.join(config.compression.jobsDir, 'incoming', `${uploadId}.pdf`);
}

export function getJobDirectory(jobId: string): string {
  return path.join(config.compression.jobsDir, jobId);
}

export function getJobInputPath(jobId: string): string {
  return path.join(getJobDirectory(jobId), 'input.pdf');
}

export function getJobOutputPath(jobId: string): string {
  return path.join(getJobDirectory(jobId), 'output.pdf');
}

export async function createJobFromUpload(
  userId: string,
  mode: CompressionMode,
  uploadPath: string,
  requestedId?: string
): Promise<CompressionJob> {
  const uploadStat = await stat(uploadPath);
  const id = requestedId || randomUUID();
  const expiresAt = new Date(
    Date.now() +
      config.compression.jobTimeoutMs +
      config.compression.retentionMs
  );
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO compression_jobs (id, user_id, input_bytes, mode, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${JOB_FIELDS}`,
    [id, userId, uploadStat.size, mode, expiresAt]
  );

  try {
    const jobDir = getJobDirectory(id);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await rename(uploadPath, getJobInputPath(id));
    return mapJob(result.rows[0]);
  } catch (error) {
    await pool.query('DELETE FROM compression_jobs WHERE id = $1', [id]);
    await rm(getJobDirectory(id), { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeResumableCompressionUpload(
  userId: string,
  mode: CompressionMode,
  uploadPath: string,
  slotId: string
): Promise<CompressionJob> {
  const uploadStat = await stat(uploadPath);
  const expiresAt = new Date(
    Date.now() +
      config.compression.jobTimeoutMs +
      config.compression.retentionMs
  );
  const client = await pool.connect();
  let moved = false;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(724091)');
    const slotResult = await client.query<Record<string, unknown>>(
      `SELECT ${UPLOAD_SLOT_FIELDS}
       FROM compression_upload_slots
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [slotId, userId]
    );
    const slotRow = slotResult.rows[0];
    if (
      !slotRow ||
      slotRow.status !== 'uploading' ||
      slotRow.mode !== mode ||
      Number(slotRow.inputBytes) !== uploadStat.size
    ) {
      throw new Error('UPLOAD_SLOT_UNAVAILABLE');
    }

    const jobResult = await client.query<Record<string, unknown>>(
      `INSERT INTO compression_jobs (id, user_id, input_bytes, mode, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${JOB_FIELDS}`,
      [slotId, userId, uploadStat.size, mode, expiresAt]
    );

    const jobDir = getJobDirectory(slotId);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await rename(uploadPath, getJobInputPath(slotId));
    moved = true;

    const attached = await client.query(
      `UPDATE compression_upload_slots
       SET status = 'processing', job_id = $3, last_activity_at = NOW(),
           expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond')
       WHERE id = $1 AND user_id = $2 AND status = 'uploading'`,
      [
        slotId,
        userId,
        slotId,
        config.compression.jobTimeoutMs + config.compression.retentionMs,
      ]
    );
    if (attached.rowCount !== 1) throw new Error('UPLOAD_SLOT_UNAVAILABLE');

    await client.query('COMMIT');
    return mapJob(jobResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (moved) {
      await rename(getJobInputPath(slotId), uploadPath).catch(
        (): undefined => undefined
      );
    }
    await rm(getJobDirectory(slotId), { recursive: true, force: true });
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupExpiredUploadSlots(): Promise<void> {
  await withUploadQueueLock(async () => undefined);
}

export async function getJobForUser(
  jobId: string,
  userId: string
): Promise<CompressionJob | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${JOB_FIELDS} FROM compression_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function getQueuePosition(
  job: CompressionJob
): Promise<number | null> {
  if (job.status !== 'queued') return null;
  const result = await pool.query<{ position: string }>(
    `SELECT COUNT(*)::text AS position
     FROM compression_jobs
     WHERE status = 'queued' AND created_at <= $1`,
    [job.createdAt]
  );
  return Number(result.rows[0].position);
}

export async function requestJobCancellation(
  jobId: string,
  userId: string
): Promise<CompressionJob | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE compression_jobs
     SET cancel_requested = true,
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         completed_at = CASE WHEN status = 'queued' THEN NOW() ELSE completed_at END
     WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing')
     RETURNING ${JOB_FIELDS}`,
    [jobId, userId]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function claimNextJob(): Promise<CompressionJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<Record<string, unknown>>(
      `WITH next_job AS (
         SELECT id
         FROM compression_jobs
         WHERE status = 'queued' AND expires_at > NOW()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE compression_jobs jobs
       SET status = 'processing', started_at = NOW()
       FROM next_job
       WHERE jobs.id = next_job.id
       RETURNING
         jobs.id,
         jobs.user_id AS "userId",
         jobs.input_bytes::text AS "inputBytes",
         jobs.mode,
         jobs.status,
         jobs.error_code AS "errorCode",
         jobs.cancel_requested AS "cancelRequested",
         jobs.created_at AS "createdAt",
         jobs.started_at AS "startedAt",
         jobs.completed_at AS "completedAt",
         jobs.expires_at AS "expiresAt"`
    );
    await client.query('COMMIT');
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobCompleted(jobId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(724091)');
    await client.query(
      `UPDATE compression_jobs
     SET status = 'completed', completed_at = NOW(), expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
     WHERE id = $1`,
      [jobId, config.compression.retentionMs]
    );
    // A completed job no longer owns the sole upload turn. The next browser
    // can upload even when the first user has not downloaded the result yet.
    await client.query(
      'DELETE FROM compression_upload_slots WHERE job_id = $1',
      [jobId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobFailed(
  jobId: string,
  errorCode: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(724091)');
    await client.query(
      `UPDATE compression_jobs
     SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
         error_code = $2,
         completed_at = NOW(),
         expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
    WHERE id = $1`,
      [jobId, errorCode, config.compression.retentionMs]
    );
    await client.query(
      'DELETE FROM compression_upload_slots WHERE job_id = $1',
      [jobId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function isCancellationRequested(jobId: string): Promise<boolean> {
  const result = await pool.query<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM compression_jobs WHERE id = $1',
    [jobId]
  );
  return Boolean(result.rows[0]?.cancel_requested);
}

export async function cleanupExpiredJobs(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM compression_jobs
     WHERE expires_at <= NOW()
       AND status IN ('completed', 'failed', 'cancelled', 'expired')
     RETURNING id`,
    []
  );
  await Promise.all(
    result.rows.map(({ id }) =>
      rm(getJobDirectory(id), { recursive: true, force: true })
    )
  );
}

export async function recoverInterruptedJobs(): Promise<void> {
  await pool.query(
    `UPDATE compression_jobs
     SET status = 'queued', started_at = NULL
     WHERE status = 'processing' AND cancel_requested = false`
  );
  await pool.query(
    `UPDATE compression_jobs
     SET status = 'cancelled', completed_at = NOW()
     WHERE status = 'processing' AND cancel_requested = true`
  );
}

export async function deleteCompletedJob(
  jobId: string,
  userId: string
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM compression_jobs
     WHERE id = $1 AND user_id = $2 AND status = 'completed'
     RETURNING id`,
    [jobId, userId]
  );
  if (result.rows[0]) {
    await rm(getJobDirectory(jobId), { recursive: true, force: true });
  }
}
