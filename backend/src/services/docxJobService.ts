import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { config } from '../config/index.js';
import { pool } from '../config/database.js';

export type DocxMode = 'editable' | 'ocr' | 'visual';
export type DocxJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface DocxJob {
  id: string;
  userId: string;
  inputBytes: number;
  mode: DocxMode;
  status: DocxJobStatus;
  stage: string;
  progress: number;
  currentPage: number | null;
  totalPages: number | null;
  errorCode: string | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface DocxUploadSlot {
  id: string;
  userId: string;
  mode: DocxMode;
  status: 'ready' | 'uploading' | 'processing';
  jobId: string | null;
  inputBytes: number;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
}

const JOB_FIELDS = `
  id, user_id AS "userId", input_bytes::text AS "inputBytes", mode, status,
  stage, progress, current_page AS "currentPage", total_pages AS "totalPages",
  error_code AS "errorCode", cancel_requested AS "cancelRequested",
  created_at AS "createdAt", started_at AS "startedAt",
  completed_at AS "completedAt", expires_at AS "expiresAt"
`;

const JOB_FIELDS_FROM_JOBS = `
  jobs.id, jobs.user_id AS "userId", jobs.input_bytes::text AS "inputBytes", jobs.mode, jobs.status,
  jobs.stage, jobs.progress, jobs.current_page AS "currentPage", jobs.total_pages AS "totalPages",
  jobs.error_code AS "errorCode", jobs.cancel_requested AS "cancelRequested",
  jobs.created_at AS "createdAt", jobs.started_at AS "startedAt",
  jobs.completed_at AS "completedAt", jobs.expires_at AS "expiresAt"
`;

const SLOT_FIELDS = `
  id, user_id AS "userId", mode, status, job_id AS "jobId",
  input_bytes::text AS "inputBytes", created_at AS "createdAt",
  last_activity_at AS "lastActivityAt", expires_at AS "expiresAt"
`;

function mapJob(row: Record<string, unknown>): DocxJob {
  return {
    id: String(row.id),
    userId: String(row.userId),
    inputBytes: Number(row.inputBytes),
    mode: row.mode as DocxMode,
    status: row.status as DocxJobStatus,
    stage: String(row.stage),
    progress: Number(row.progress),
    currentPage: row.currentPage === null ? null : Number(row.currentPage),
    totalPages: row.totalPages === null ? null : Number(row.totalPages),
    errorCode: row.errorCode ? String(row.errorCode) : null,
    cancelRequested: Boolean(row.cancelRequested),
    createdAt: new Date(String(row.createdAt)),
    startedAt: row.startedAt ? new Date(String(row.startedAt)) : null,
    completedAt: row.completedAt ? new Date(String(row.completedAt)) : null,
    expiresAt: new Date(String(row.expiresAt)),
  };
}

function mapSlot(row: Record<string, unknown>): DocxUploadSlot {
  return {
    id: String(row.id),
    userId: String(row.userId),
    mode: row.mode as DocxMode,
    status: row.status as DocxUploadSlot['status'],
    jobId: row.jobId ? String(row.jobId) : null,
    inputBytes: Number(row.inputBytes),
    createdAt: new Date(String(row.createdAt)),
    lastActivityAt: new Date(String(row.lastActivityAt)),
    expiresAt: new Date(String(row.expiresAt)),
  };
}

function slotExpiry(): Date {
  return new Date(Date.now() + config.docx.uploadIdleTimeoutMs);
}

async function withSlotLock<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(724093)');
    await client.query(
      `DELETE FROM docx_upload_slots
       WHERE expires_at <= NOW() OR status = 'processing' AND EXISTS (
         SELECT 1 FROM docx_jobs WHERE docx_jobs.id = docx_upload_slots.job_id
         AND status IN ('completed', 'failed', 'cancelled', 'expired')
       )`
    );
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

export function ensureDocxStorage(): void {
  for (const dir of [getDocxRootDirectory(), getDocxUploadDirectory()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function getDocxRootDirectory(): string {
  return path.join(config.docx.jobsDir, 'docx');
}

export function getDocxUploadDirectory(): string {
  return path.join(getDocxRootDirectory(), 'uploads');
}

export function getDocxUploadPath(uploadId: string): string {
  return path.join(getDocxUploadDirectory(), uploadId);
}

export function getDocxJobDirectory(jobId: string): string {
  return path.join(getDocxRootDirectory(), jobId);
}

export function getDocxJobInputPath(jobId: string): string {
  return path.join(getDocxJobDirectory(jobId), 'input.pdf');
}

export function getDocxJobOutputPath(jobId: string): string {
  return path.join(getDocxJobDirectory(jobId), 'result.docx');
}

export async function removeDocxTusUploadArtifacts(uploadId: string): Promise<void> {
  await Promise.all([
    rm(getDocxUploadPath(uploadId), { force: true }),
    rm(`${getDocxUploadPath(uploadId)}.json`, { force: true }),
  ]);
}

export async function ensureDocxDiskCapacity(inputBytes: number): Promise<void> {
  ensureDocxStorage();
  const filesystem = await statfs(config.docx.jobsDir);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = Math.max(
    config.docx.diskMinimumFreeBytes,
    inputBytes * config.docx.diskHeadroomMultiplier
  );
  if (availableBytes < requiredBytes) throw new Error('INSUFFICIENT_STORAGE');
}

export async function reserveDocxUploadSlot(
  userId: string,
  mode: DocxMode,
  inputBytes: number
): Promise<DocxUploadSlot> {
  return withSlotLock(async (client) => {
    const existing = await client.query<Record<string, unknown>>(
      `SELECT ${SLOT_FIELDS} FROM docx_upload_slots
       WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (existing.rows[0]) {
      const slot = mapSlot(existing.rows[0]);
      if (slot.mode !== mode || slot.inputBytes !== inputBytes) {
        throw new Error('ACTIVE_UPLOAD_EXISTS');
      }
      await client.query(
        `UPDATE docx_upload_slots SET last_activity_at = NOW(), expires_at = $2
         WHERE id = $1`,
        [slot.id, slotExpiry()]
      );
      const refreshed = await client.query<Record<string, unknown>>(
        `SELECT ${SLOT_FIELDS} FROM docx_upload_slots WHERE id = $1`,
        [slot.id]
      );
      return mapSlot(refreshed.rows[0]);
    }
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO docx_upload_slots (user_id, mode, input_bytes, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING ${SLOT_FIELDS}`,
      [userId, mode, inputBytes, slotExpiry()]
    );
    return mapSlot(inserted.rows[0]);
  });
}

export async function getDocxUploadSlot(
  slotId: string,
  userId: string
): Promise<DocxUploadSlot | null> {
  return withSlotLock(async (client) => {
    await client.query(
      `UPDATE docx_upload_slots
       SET last_activity_at = NOW(),
           expires_at = CASE WHEN status = 'processing' THEN expires_at ELSE $3 END
       WHERE id = $1 AND user_id = $2`,
      [slotId, userId, slotExpiry()]
    );
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${SLOT_FIELDS} FROM docx_upload_slots WHERE id = $1 AND user_id = $2`,
      [slotId, userId]
    );
    return result.rows[0] ? mapSlot(result.rows[0]) : null;
  });
}

export async function claimDocxUploadSlot(
  slotId: string,
  userId: string,
  mode: DocxMode,
  inputBytes: number
): Promise<DocxUploadSlot | null> {
  return withSlotLock(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `UPDATE docx_upload_slots
       SET status = 'uploading', last_activity_at = NOW(), expires_at = $5
       WHERE id = $1 AND user_id = $2 AND mode = $3 AND input_bytes = $4
         AND status = 'ready'
       RETURNING ${SLOT_FIELDS}`,
      [slotId, userId, mode, inputBytes, slotExpiry()]
    );
    return result.rows[0] ? mapSlot(result.rows[0]) : null;
  });
}

export async function authorizeDocxUpload(
  slotId: string,
  userId: string
): Promise<DocxUploadSlot | null> {
  return withSlotLock(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `UPDATE docx_upload_slots
       SET last_activity_at = NOW(), expires_at = $3
       WHERE id = $1 AND user_id = $2 AND status = 'uploading'
       RETURNING ${SLOT_FIELDS}`,
      [slotId, userId, slotExpiry()]
    );
    if (result.rows[0]) return mapSlot(result.rows[0]);
    const processing = await client.query<Record<string, unknown>>(
      `SELECT ${SLOT_FIELDS} FROM docx_upload_slots
       WHERE id = $1 AND user_id = $2 AND status = 'processing'`,
      [slotId, userId]
    );
    return processing.rows[0] ? mapSlot(processing.rows[0]) : null;
  });
}

export async function resetDocxUploadSlot(
  slotId: string,
  userId: string
): Promise<DocxUploadSlot | null> {
  const slot = await withSlotLock(async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `UPDATE docx_upload_slots
       SET status = 'ready', last_activity_at = NOW(), expires_at = $3
       WHERE id = $1 AND user_id = $2 AND status = 'uploading' AND job_id IS NULL
       RETURNING ${SLOT_FIELDS}`,
      [slotId, userId, slotExpiry()]
    );
    return result.rows[0] ? mapSlot(result.rows[0]) : null;
  });
  if (slot) await removeDocxTusUploadArtifacts(slotId);
  return slot;
}

export async function releaseDocxUploadSlot(slotId: string, userId: string): Promise<void> {
  const released = await withSlotLock(async (client) => {
    const result = await client.query(
      `DELETE FROM docx_upload_slots
       WHERE id = $1 AND user_id = $2 AND job_id IS NULL RETURNING id`,
      [slotId, userId]
    );
    return result.rowCount === 1;
  });
  if (released) await removeDocxTusUploadArtifacts(slotId);
}

export async function finalizeDocxUpload(
  userId: string,
  mode: DocxMode,
  uploadPath: string,
  slotId: string
): Promise<DocxJob> {
  const uploadStat = await stat(uploadPath);
  let moved = false;
  let jobId = '';
  try {
    return await withSlotLock(async (client) => {
      const slotResult = await client.query<Record<string, unknown>>(
        `SELECT ${SLOT_FIELDS} FROM docx_upload_slots
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [slotId, userId]
      );
      const slot = slotResult.rows[0] ? mapSlot(slotResult.rows[0]) : null;
      if (!slot || slot.status !== 'uploading' || slot.mode !== mode || slot.inputBytes !== uploadStat.size) {
        throw new Error('UPLOAD_SLOT_UNAVAILABLE');
      }
      const expiresAt = new Date(Date.now() + config.docx.jobTimeoutMs + config.docx.retentionMs);
      const jobResult = await client.query<Record<string, unknown>>(
        `INSERT INTO docx_jobs (id, user_id, input_bytes, mode, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${JOB_FIELDS}`,
        [slotId, userId, uploadStat.size, mode, expiresAt]
      );
      jobId = slotId;
      await mkdir(getDocxJobDirectory(jobId), { recursive: true, mode: 0o700 });
      await rename(uploadPath, getDocxJobInputPath(jobId));
      moved = true;
      const attached = await client.query(
        `UPDATE docx_upload_slots
         SET status = 'processing', job_id = $3, last_activity_at = NOW(), expires_at = $4
         WHERE id = $1 AND user_id = $2 AND status = 'uploading'`,
        [slotId, userId, jobId, expiresAt]
      );
      if (attached.rowCount !== 1) throw new Error('UPLOAD_SLOT_UNAVAILABLE');
      return mapJob(jobResult.rows[0]);
    });
  } catch (error) {
    if (moved && jobId) await rm(getDocxJobDirectory(jobId), { recursive: true, force: true });
    throw error;
  }
}

export async function getDocxJobForUser(jobId: string, userId: string): Promise<DocxJob | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${JOB_FIELDS} FROM docx_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function getDocxQueuePosition(job: DocxJob): Promise<number | null> {
  if (job.status !== 'queued') return null;
  const result = await pool.query<{ position: string }>(
    `SELECT COUNT(*)::text AS position FROM docx_jobs
     WHERE status = 'queued' AND created_at <= $1`,
    [job.createdAt]
  );
  return Number(result.rows[0].position);
}

export async function requestDocxCancellation(jobId: string, userId: string): Promise<DocxJob | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE docx_jobs
     SET cancel_requested = true,
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         stage = CASE WHEN status = 'queued' THEN 'cancelled' ELSE stage END,
         completed_at = CASE WHEN status = 'queued' THEN NOW() ELSE completed_at END
     WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'processing')
     RETURNING ${JOB_FIELDS}`,
    [jobId, userId]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function claimNextDocxJob(): Promise<DocxJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<Record<string, unknown>>(
      `WITH next_job AS (
        SELECT id FROM docx_jobs WHERE status = 'queued' AND expires_at > NOW()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE docx_jobs jobs
      SET status = 'processing', stage = 'validating', progress = 3, started_at = NOW()
      FROM next_job WHERE jobs.id = next_job.id
      RETURNING ${JOB_FIELDS_FROM_JOBS}`
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

export async function updateDocxProgress(
  jobId: string,
  stage: string,
  progress: number,
  currentPage?: number | null,
  totalPages?: number | null
): Promise<void> {
  await pool.query(
    `UPDATE docx_jobs SET stage = $2, progress = $3,
       current_page = COALESCE($4, current_page), total_pages = COALESCE($5, total_pages)
     WHERE id = $1 AND status = 'processing'`,
    [jobId, stage, Math.max(0, Math.min(100, Math.round(progress))), currentPage ?? null, totalPages ?? null]
  );
}

async function releaseSlotForJob(client: PoolClient, jobId: string): Promise<void> {
  await client.query('DELETE FROM docx_upload_slots WHERE job_id = $1', [jobId]);
}

export async function markDocxCompleted(jobId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE docx_jobs SET status = 'completed', stage = 'completed', progress = 100,
       completed_at = NOW(), expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
       WHERE id = $1`,
      [jobId, config.docx.retentionMs]
    );
    await releaseSlotForJob(client, jobId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markDocxFailed(jobId: string, errorCode: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE docx_jobs SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
       stage = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
       error_code = $2, completed_at = NOW(),
       expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond') WHERE id = $1`,
      [jobId, errorCode, config.docx.retentionMs]
    );
    await releaseSlotForJob(client, jobId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function isDocxCancellationRequested(jobId: string): Promise<boolean> {
  const result = await pool.query<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM docx_jobs WHERE id = $1',
    [jobId]
  );
  return Boolean(result.rows[0]?.cancel_requested);
}

export async function cleanupExpiredDocxJobs(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM docx_jobs WHERE expires_at <= NOW()
     AND status IN ('completed', 'failed', 'cancelled', 'expired') RETURNING id`
  );
  await Promise.all(result.rows.map(({ id }) => rm(getDocxJobDirectory(id), { recursive: true, force: true })));
}

export async function cleanupExpiredDocxUploadSlots(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM docx_upload_slots WHERE expires_at <= NOW() AND job_id IS NULL RETURNING id`
  );
  await Promise.all(result.rows.map(({ id }) => removeDocxTusUploadArtifacts(id)));
}

export async function deleteCompletedDocxJob(jobId: string, userId: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM docx_jobs WHERE id = $1 AND user_id = $2 AND status = 'completed' RETURNING id`,
    [jobId, userId]
  );
  if (result.rows[0]) await rm(getDocxJobDirectory(jobId), { recursive: true, force: true });
}

export async function recoverInterruptedDocxJobs(): Promise<void> {
  await pool.query(
    `UPDATE docx_jobs SET status = 'queued', stage = 'queued', started_at = NULL
     WHERE status = 'processing' AND cancel_requested = false`
  );
  await pool.query(
    `UPDATE docx_jobs SET status = 'cancelled', stage = 'cancelled', completed_at = NOW()
     WHERE status = 'processing' AND cancel_requested = true`
  );
}
