import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
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

export function ensureCompressionStorage(): void {
  if (!existsSync(config.compression.jobsDir)) {
    mkdirSync(config.compression.jobsDir, { recursive: true, mode: 0o700 });
  }
  const incomingDir = path.join(config.compression.jobsDir, 'incoming');
  if (!existsSync(incomingDir)) {
    mkdirSync(incomingDir, { recursive: true, mode: 0o700 });
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
  uploadPath: string
): Promise<CompressionJob> {
  const uploadStat = await stat(uploadPath);
  const id = randomUUID();
  const expiresAt = new Date(
    Date.now() + config.compression.jobTimeoutMs + config.compression.retentionMs
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

export async function getQueuePosition(job: CompressionJob): Promise<number | null> {
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
  await pool.query(
    `UPDATE compression_jobs
     SET status = 'completed', completed_at = NOW(), expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
     WHERE id = $1`,
    [jobId, config.compression.retentionMs]
  );
}

export async function markJobFailed(
  jobId: string,
  errorCode: string
): Promise<void> {
  await pool.query(
    `UPDATE compression_jobs
     SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
         error_code = $2,
         completed_at = NOW(),
         expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
     WHERE id = $1`,
    [jobId, errorCode, config.compression.retentionMs]
  );
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
    result.rows.map(({ id }) => rm(getJobDirectory(id), { recursive: true, force: true }))
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

export async function deleteCompletedJob(jobId: string, userId: string): Promise<void> {
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
