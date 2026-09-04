import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { config } from '../config/index.js';
import { pool } from '../config/database.js';
import {
  type GuideAssetType,
  type ValidatedStoredFile,
  validateGuideFileName,
} from '../utils/fileValidation.js';

export interface GuideMaterial {
  id: string;
  title: string;
  description: string;
  assetType: GuideAssetType;
  assetStatus: 'pending' | 'uploading' | 'ready';
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  position: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GuideUploadSlot {
  id: string;
  guideId: string;
  userId: string;
  originalFilename: string;
  expectedBytes: number;
  status: 'ready' | 'uploading' | 'completed';
  assetType: GuideAssetType;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
}

export class GuideServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'GuideServiceError';
  }
}

const GUIDE_FIELDS = `
  id, title, description, asset_type AS "assetType", asset_status AS "assetStatus",
  original_filename AS "originalFilename", mime_type AS "mimeType",
  size_bytes::text AS "sizeBytes", position, is_published AS "isPublished",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const GUIDE_INTERNAL_FIELDS = `${GUIDE_FIELDS}, storage_key AS "storageKey"`;

const SLOT_FIELDS = `
  slots.id, slots.guide_id AS "guideId", slots.user_id AS "userId",
  slots.original_filename AS "originalFilename",
  slots.expected_bytes::text AS "expectedBytes", slots.status,
  guides.asset_type AS "assetType", slots.created_at AS "createdAt",
  slots.last_activity_at AS "lastActivityAt", slots.expires_at AS "expiresAt"
`;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapGuide(row: Record<string, unknown>): GuideMaterial {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    assetType: row.assetType as GuideAssetType,
    assetStatus: row.assetStatus as GuideMaterial['assetStatus'],
    originalFilename: nullableString(row.originalFilename),
    mimeType: nullableString(row.mimeType),
    sizeBytes:
      row.sizeBytes === null || row.sizeBytes === undefined
        ? null
        : Number(row.sizeBytes),
    position: Number(row.position),
    isPublished: Boolean(row.isPublished),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapSlot(row: Record<string, unknown>): GuideUploadSlot {
  return {
    id: String(row.id),
    guideId: String(row.guideId),
    userId: String(row.userId),
    originalFilename: String(row.originalFilename),
    expectedBytes: Number(row.expectedBytes),
    status: row.status as GuideUploadSlot['status'],
    assetType: row.assetType as GuideAssetType,
    createdAt: asDate(row.createdAt),
    lastActivityAt: asDate(row.lastActivityAt),
    expiresAt: asDate(row.expiresAt),
  };
}

function slotExpiry(): Date {
  return new Date(Date.now() + config.support.uploadIdleTimeoutMs);
}

function guideRoot(): string {
  return path.join(config.support.storageDir, 'guides');
}

export function getGuideUploadDirectory(): string {
  return path.join(guideRoot(), 'uploads');
}

function getGuideAssetDirectory(): string {
  return path.join(guideRoot(), 'assets');
}

export function getGuideUploadPath(uploadId: string): string {
  return path.join(getGuideUploadDirectory(), uploadId);
}

export function getGuideAssetPath(storageKey: string): string {
  return path.join(getGuideAssetDirectory(), storageKey);
}

export function ensureGuideStorage(): void {
  for (const directory of [
    config.support.storageDir,
    guideRoot(),
    getGuideUploadDirectory(),
    getGuideAssetDirectory(),
  ]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
}

export async function removeGuideTusUploadArtifacts(uploadId: string): Promise<void> {
  await Promise.all([
    rm(getGuideUploadPath(uploadId), { force: true }),
    rm(`${getGuideUploadPath(uploadId)}.json`, { force: true }),
  ]);
}

function maxBytesForGuideType(assetType: GuideAssetType): number {
  return assetType === 'pdf'
    ? config.support.guidePdfMaxBytes
    : config.support.guideVideoMaxBytes;
}

export function guidePublicConfig() {
  return {
    pdfMaxBytes: config.support.guidePdfMaxBytes,
    videoMaxBytes: config.support.guideVideoMaxBytes,
    uploadChunkBytes: config.support.uploadChunkBytes,
  };
}

export async function ensureGuideDiskCapacity(inputBytes: number): Promise<void> {
  ensureGuideStorage();
  const filesystem = await statfs(config.support.storageDir);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (availableBytes < inputBytes + config.support.diskMinimumFreeBytes) {
    throw new GuideServiceError(
      'INSUFFICIENT_STORAGE',
      'Ruang penyimpanan materi tidak mencukupi',
      507
    );
  }
}

export async function createGuideMaterial(input: {
  title: string;
  description: string;
  assetType: GuideAssetType;
  adminId: string;
}): Promise<GuideMaterial> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nextPosition = await client.query<{ position: number }>(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM guide_materials'
    );
    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO guide_materials (
         title, description, asset_type, position, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING ${GUIDE_FIELDS}`,
      [
        input.title,
        input.description,
        input.assetType,
        Number(nextPosition.rows[0].position),
        input.adminId,
      ]
    );
    await client.query('COMMIT');
    return mapGuide(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listGuideMaterialsForAdmin(): Promise<GuideMaterial[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${GUIDE_FIELDS} FROM guide_materials
     ORDER BY position ASC, created_at ASC`
  );
  return result.rows.map(mapGuide);
}

export async function listPublishedGuideMaterials(): Promise<GuideMaterial[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${GUIDE_FIELDS} FROM guide_materials
     WHERE is_published = true AND asset_status = 'ready'
       AND storage_key IS NOT NULL
     ORDER BY position ASC, created_at ASC`
  );
  return result.rows.map(mapGuide);
}

export async function updateGuideMaterial(
  guideId: string,
  input: {
    title?: string;
    description?: string;
    isPublished?: boolean;
  },
  adminId: string
): Promise<GuideMaterial | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query<Record<string, unknown>>(
      `SELECT ${GUIDE_INTERNAL_FIELDS} FROM guide_materials
       WHERE id = $1 FOR UPDATE`,
      [guideId]
    );
    if (!currentResult.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const current = currentResult.rows[0];
    if (input.isPublished === true && current.assetStatus !== 'ready') {
      throw new GuideServiceError(
        'GUIDE_ASSET_REQUIRED',
        'Unggah file materi sebelum mempublikasikannya',
        409
      );
    }

    const values: unknown[] = [guideId];
    const sets: string[] = [];
    if (input.title !== undefined) {
      values.push(input.title);
      sets.push(`title = $${values.length}`);
    }
    if (input.description !== undefined) {
      values.push(input.description);
      sets.push(`description = $${values.length}`);
    }
    if (input.isPublished !== undefined) {
      values.push(input.isPublished);
      sets.push(`is_published = $${values.length}`);
    }
    values.push(adminId);
    sets.push(`updated_by = $${values.length}`, 'updated_at = NOW()');

    const updated = await client.query<Record<string, unknown>>(
      `UPDATE guide_materials SET ${sets.join(', ')}
       WHERE id = $1 RETURNING ${GUIDE_FIELDS}`,
      values
    );
    await client.query('COMMIT');
    return mapGuide(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getGuideSlotById(
  client: PoolClient,
  slotId: string,
  userId: string
): Promise<GuideUploadSlot | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${SLOT_FIELDS} FROM guide_upload_slots slots
     INNER JOIN guide_materials guides ON guides.id = slots.guide_id
     WHERE slots.id = $1 AND slots.user_id = $2`,
    [slotId, userId]
  );
  return result.rows[0] ? mapSlot(result.rows[0]) : null;
}

export async function createGuideUploadSlot(
  guideId: string,
  adminId: string,
  originalFilename: string,
  expectedBytes: number
): Promise<GuideUploadSlot> {
  const client = await pool.connect();
  let staleSlotIds: string[] = [];
  try {
    await client.query('BEGIN');
    const expired = await client.query<{ id: string }>(
      `DELETE FROM guide_upload_slots
       WHERE guide_id = $1 AND status IN ('ready', 'uploading')
         AND expires_at <= NOW()
       RETURNING id`,
      [guideId]
    );
    staleSlotIds = expired.rows.map((row) => row.id);

    const guideResult = await client.query<Record<string, unknown>>(
      `SELECT ${GUIDE_INTERNAL_FIELDS} FROM guide_materials
       WHERE id = $1 FOR UPDATE`,
      [guideId]
    );
    if (!guideResult.rows[0]) {
      throw new GuideServiceError('GUIDE_NOT_FOUND', 'Materi tidak ditemukan', 404);
    }
    const guide = guideResult.rows[0];
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw new GuideServiceError(
        'INVALID_FILE_SIZE',
        'Ukuran file tidak valid',
        400
      );
    }
    const maximum = maxBytesForGuideType(guide.assetType as GuideAssetType);
    if (expectedBytes > maximum) {
      throw new GuideServiceError(
        'FILE_TOO_LARGE',
        'Ukuran file materi melampaui batas yang diizinkan',
        413
      );
    }
    const validated = validateGuideFileName(
      originalFilename,
      guide.assetType as GuideAssetType
    );
    const active = await client.query<{ id: string }>(
      `SELECT id FROM guide_upload_slots
       WHERE guide_id = $1 AND status IN ('ready', 'uploading') LIMIT 1`,
      [guideId]
    );
    if (active.rows[0]) {
      throw new GuideServiceError(
        'ACTIVE_UPLOAD_EXISTS',
        'Masih ada upload materi yang berjalan. Lanjutkan atau batalkan upload tersebut.',
        409
      );
    }
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO guide_upload_slots (
         guide_id, user_id, original_filename, expected_bytes, expires_at
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [guideId, adminId, validated.fileName, expectedBytes, slotExpiry()]
    );
    const slot = await getGuideSlotById(
      client,
      String(inserted.rows[0].id),
      adminId
    );
    if (!slot) throw new Error('GUIDE_UPLOAD_SLOT_NOT_CREATED');
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await Promise.all(staleSlotIds.map(removeGuideTusUploadArtifacts));
  }
}

export async function getGuideUploadSlot(
  slotId: string,
  adminId: string
): Promise<GuideUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE guide_upload_slots
       SET last_activity_at = NOW(),
           expires_at = CASE WHEN status = 'completed' THEN expires_at ELSE $3 END
       WHERE id = $1 AND user_id = $2`,
      [slotId, adminId, slotExpiry()]
    );
    const slot = await getGuideSlotById(client, slotId, adminId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimGuideUploadSlot(
  slotId: string,
  adminId: string,
  inputBytes: number
): Promise<GuideUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const update = await client.query<{ id: string }>(
      `UPDATE guide_upload_slots
       SET status = 'uploading', last_activity_at = NOW(), expires_at = $4
       WHERE id = $1 AND user_id = $2 AND expected_bytes = $3
         AND status = 'ready' AND expires_at > NOW()
       RETURNING id`,
      [slotId, adminId, inputBytes, slotExpiry()]
    );
    if (!update.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const slot = await getGuideSlotById(client, slotId, adminId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authorizeGuideUpload(
  slotId: string,
  adminId: string
): Promise<GuideUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const update = await client.query<{ id: string }>(
      `UPDATE guide_upload_slots
       SET last_activity_at = NOW(), expires_at = $3
       WHERE id = $1 AND user_id = $2 AND status = 'uploading'
         AND expires_at > NOW()
       RETURNING id`,
      [slotId, adminId, slotExpiry()]
    );
    if (!update.rows[0]) {
      const completed = await getGuideSlotById(client, slotId, adminId);
      await client.query('COMMIT');
      return completed?.status === 'completed' ? completed : null;
    }
    const slot = await getGuideSlotById(client, slotId, adminId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetGuideUploadSlot(
  slotId: string,
  adminId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ guideId: string }>(
      `UPDATE guide_upload_slots
       SET status = 'ready', last_activity_at = NOW(), expires_at = $3
       WHERE id = $1 AND user_id = $2 AND status = 'uploading'
       RETURNING guide_id AS "guideId"`,
      [slotId, adminId, slotExpiry()]
    );
    if (result.rows[0]) {
      await client.query(
        `UPDATE guide_materials
         SET asset_status = CASE WHEN storage_key IS NULL THEN 'pending' ELSE 'ready' END,
             updated_at = NOW()
         WHERE id = $1`,
        [result.rows[0].guideId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await removeGuideTusUploadArtifacts(slotId);
}

export async function releaseGuideUploadSlot(
  slotId: string,
  adminId: string
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM guide_upload_slots
     WHERE id = $1 AND user_id = $2 AND status IN ('ready', 'uploading')
     RETURNING id`,
    [slotId, adminId]
  );
  if (result.rows[0]) await removeGuideTusUploadArtifacts(slotId);
}

export async function finalizeGuideUpload(
  slotId: string,
  adminId: string,
  uploadPath: string,
  validatedFile: ValidatedStoredFile
): Promise<GuideMaterial> {
  const uploadedFile = await stat(uploadPath);
  const client = await pool.connect();
  let finalPath = '';
  let moved = false;
  let previousStorageKey: string | null;
  let committed = false;
  try {
    await client.query('BEGIN');
    const slotResult = await client.query<Record<string, unknown>>(
      `SELECT ${SLOT_FIELDS} FROM guide_upload_slots slots
       INNER JOIN guide_materials guides ON guides.id = slots.guide_id
       WHERE slots.id = $1 AND slots.user_id = $2 FOR UPDATE`,
      [slotId, adminId]
    );
    const slot = slotResult.rows[0] ? mapSlot(slotResult.rows[0]) : null;
    if (
      !slot ||
      slot.status !== 'uploading' ||
      slot.expectedBytes !== uploadedFile.size ||
      (slot.assetType === 'pdf' && validatedFile.kind !== 'pdf') ||
      (slot.assetType === 'video' && validatedFile.kind !== 'mp4') ||
      slot.originalFilename !== validatedFile.fileName
    ) {
      throw new GuideServiceError(
        'UPLOAD_SLOT_UNAVAILABLE',
        'Slot upload materi tidak lagi tersedia',
        409
      );
    }
    const guideResult = await client.query<Record<string, unknown>>(
      `SELECT storage_key AS "storageKey" FROM guide_materials
       WHERE id = $1 FOR UPDATE`,
      [slot.guideId]
    );
    previousStorageKey = nullableString(guideResult.rows[0]?.storageKey);

    await mkdir(getGuideAssetDirectory(), { recursive: true, mode: 0o700 });
    finalPath = getGuideAssetPath(slot.id);
    await rename(uploadPath, finalPath);
    moved = true;
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE guide_materials
       SET asset_status = 'ready', original_filename = $2, storage_key = $3,
           mime_type = $4, size_bytes = $5, updated_by = $6, updated_at = NOW()
       WHERE id = $1
       RETURNING ${GUIDE_FIELDS}`,
      [
        slot.guideId,
        validatedFile.fileName,
        slot.id,
        validatedFile.mimeType,
        uploadedFile.size,
        adminId,
      ]
    );
    await client.query(
      `UPDATE guide_upload_slots
       SET status = 'completed', last_activity_at = NOW(), expires_at = $2
       WHERE id = $1`,
      [slot.id, new Date(Date.now() + config.support.uploadMaxAgeMs)]
    );
    const updatedGuide = mapGuide(updated.rows[0]);
    await client.query('COMMIT');
    committed = true;
    if (previousStorageKey && previousStorageKey !== slot.id) {
      await rm(getGuideAssetPath(previousStorageKey), { force: true }).catch(
        () => undefined
      );
    }
    return updatedGuide;
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (moved && finalPath) await rm(finalPath, { force: true });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getGuideAsset(
  guideId: string,
  publishedOnly: boolean
): Promise<
  | (GuideMaterial & {
      storagePath: string;
    })
  | null
> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${GUIDE_INTERNAL_FIELDS} FROM guide_materials
     WHERE id = $1 AND asset_status = 'ready' AND storage_key IS NOT NULL
       ${publishedOnly ? 'AND is_published = true' : ''}`,
    [guideId]
  );
  if (!result.rows[0]) return null;
  const guide = mapGuide(result.rows[0]);
  return {
    ...guide,
    storagePath: getGuideAssetPath(String(result.rows[0].storageKey)),
  };
}

export async function deleteGuideMaterial(guideId: string): Promise<boolean> {
  const client = await pool.connect();
  let storageKey: string | null;
  let uploadSlotIds: string[];
  try {
    await client.query('BEGIN');
    const existing = await client.query<Record<string, unknown>>(
      `SELECT storage_key AS "storageKey" FROM guide_materials
       WHERE id = $1 FOR UPDATE`,
      [guideId]
    );
    if (!existing.rows[0]) {
      await client.query('COMMIT');
      return false;
    }
    storageKey = nullableString(existing.rows[0].storageKey);
    const slots = await client.query<{ id: string }>(
      'SELECT id FROM guide_upload_slots WHERE guide_id = $1',
      [guideId]
    );
    uploadSlotIds = slots.rows.map((row) => row.id);
    await client.query('DELETE FROM guide_materials WHERE id = $1', [guideId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await Promise.all([
    ...(storageKey ? [rm(getGuideAssetPath(storageKey), { force: true })] : []),
    ...uploadSlotIds.map(removeGuideTusUploadArtifacts),
  ]);
  return true;
}

export async function reorderGuideMaterials(ids: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ id: string }>(
      'SELECT id FROM guide_materials ORDER BY position ASC, created_at ASC FOR UPDATE'
    );
    if (
      current.rows.length !== ids.length ||
      new Set(ids).size !== ids.length ||
      current.rows.some((row) => !ids.includes(row.id))
    ) {
      throw new GuideServiceError(
        'INVALID_GUIDE_ORDER',
        'Urutan materi tidak sesuai dengan data saat ini',
        409
      );
    }
    for (const [position, id] of ids.entries()) {
      await client.query(
        'UPDATE guide_materials SET position = $2, updated_at = NOW() WHERE id = $1',
        [id, position]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupExpiredGuideUploadSlots(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM guide_upload_slots
     WHERE status IN ('ready', 'uploading') AND expires_at <= NOW()
     RETURNING id`
  );
  await Promise.all(result.rows.map(({ id }) => removeGuideTusUploadArtifacts(id)));
}
