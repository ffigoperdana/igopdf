import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config/index.js';
import { pool } from '../config/database.js';
import {
  type ComplaintCategory,
  type StoredFileKind,
  type ValidatedStoredFile,
  validateComplaintFileName,
} from '../utils/fileValidation.js';

export type ComplaintStatus = 'draft' | 'open' | 'in_progress' | 'resolved';
export type MainComplaintFeatureId =
  | 'compress-pdf'
  | 'pdf-to-docx'
  | 'edit-pdf';

export interface ComplaintTicket {
  id: string;
  ticketNumber: string;
  reporterId: string | null;
  reporterUsername: string;
  category: ComplaintCategory;
  featureId: string | null;
  featureName: string | null;
  subject: string;
  contentHtml: string;
  contentText: string;
  status: ComplaintStatus;
  uploadExpiresAt: Date;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionHtml: string | null;
  resolutionText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComplaintAttachment {
  id: string;
  ticketId: string;
  originalFilename: string;
  fileKind: StoredFileKind;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  expiresAt: Date;
  purgedAt: Date | null;
  available: boolean;
}

export interface ComplaintUploadSlot {
  id: string;
  ticketId: string;
  userId: string;
  originalFilename: string;
  fileKind: StoredFileKind;
  expectedBytes: number;
  status: 'ready' | 'uploading' | 'completed';
  category: ComplaintCategory;
  featureId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
}

export interface ComplaintAttachmentPolicy {
  maxFiles: number;
  maxBytesPerFile: number;
  acceptedExtensions: string[];
}

export class ComplaintServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'ComplaintServiceError';
  }
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const MAIN_COMPLAINT_FEATURES: ReadonlyArray<{
  id: MainComplaintFeatureId;
  name: string;
  maxBytesPerFile: number;
}> = [
  {
    id: 'compress-pdf',
    name: 'Compress PDF',
    maxBytesPerFile: GIB,
  },
  {
    id: 'pdf-to-docx',
    name: 'PDF to DOCX',
    maxBytesPerFile: 500 * MIB,
  },
  {
    id: 'edit-pdf',
    name: 'Text Editor PDF',
    maxBytesPerFile: 500 * MIB,
  },
] as const;

const TICKET_FIELDS = `
  id, ticket_number AS "ticketNumber", reporter_id AS "reporterId",
  reporter_username AS "reporterUsername", category, feature_id AS "featureId",
  feature_name AS "featureName", subject, content_html AS "contentHtml",
  content_text AS "contentText", status, upload_expires_at AS "uploadExpiresAt",
  submitted_at AS "submittedAt", resolved_at AS "resolvedAt",
  resolved_by AS "resolvedBy", resolution_html AS "resolutionHtml",
  resolution_text AS "resolutionText", created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const ATTACHMENT_FIELDS = `
  id, ticket_id AS "ticketId", original_filename AS "originalFilename",
  file_kind AS "fileKind", mime_type AS "mimeType", size_bytes::text AS "sizeBytes",
  uploaded_at AS "uploadedAt", expires_at AS "expiresAt", purged_at AS "purgedAt"
`;

const SLOT_FIELDS = `
  slots.id, slots.ticket_id AS "ticketId", slots.user_id AS "userId",
  slots.original_filename AS "originalFilename", slots.file_kind AS "fileKind",
  slots.expected_bytes::text AS "expectedBytes", slots.status,
  tickets.category, tickets.feature_id AS "featureId",
  slots.created_at AS "createdAt", slots.last_activity_at AS "lastActivityAt",
  slots.expires_at AS "expiresAt"
`;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapTicket(row: Record<string, unknown>): ComplaintTicket {
  return {
    id: String(row.id),
    ticketNumber: String(row.ticketNumber),
    reporterId: asNullableString(row.reporterId),
    reporterUsername: String(row.reporterUsername),
    category: row.category as ComplaintCategory,
    featureId: asNullableString(row.featureId),
    featureName: asNullableString(row.featureName),
    subject: String(row.subject),
    contentHtml: String(row.contentHtml),
    contentText: String(row.contentText),
    status: row.status as ComplaintStatus,
    uploadExpiresAt: asDate(row.uploadExpiresAt),
    submittedAt: row.submittedAt ? asDate(row.submittedAt) : null,
    resolvedAt: row.resolvedAt ? asDate(row.resolvedAt) : null,
    resolvedBy: asNullableString(row.resolvedBy),
    resolutionHtml: asNullableString(row.resolutionHtml),
    resolutionText: asNullableString(row.resolutionText),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

function mapAttachment(row: Record<string, unknown>): ComplaintAttachment {
  const expiresAt = asDate(row.expiresAt);
  const purgedAt = row.purgedAt ? asDate(row.purgedAt) : null;
  return {
    id: String(row.id),
    ticketId: String(row.ticketId),
    originalFilename: String(row.originalFilename),
    fileKind: row.fileKind as StoredFileKind,
    mimeType: String(row.mimeType),
    sizeBytes: Number(row.sizeBytes),
    uploadedAt: asDate(row.uploadedAt),
    expiresAt,
    purgedAt,
    available: !purgedAt && expiresAt.getTime() > Date.now(),
  };
}

function mapSlot(row: Record<string, unknown>): ComplaintUploadSlot {
  return {
    id: String(row.id),
    ticketId: String(row.ticketId),
    userId: String(row.userId),
    originalFilename: String(row.originalFilename),
    fileKind: row.fileKind as StoredFileKind,
    expectedBytes: Number(row.expectedBytes),
    status: row.status as ComplaintUploadSlot['status'],
    category: row.category as ComplaintCategory,
    featureId: asNullableString(row.featureId),
    createdAt: asDate(row.createdAt),
    lastActivityAt: asDate(row.lastActivityAt),
    expiresAt: asDate(row.expiresAt),
  };
}

function slotExpiry(): Date {
  return new Date(Date.now() + config.support.uploadIdleTimeoutMs);
}

function draftExpiry(): Date {
  return new Date(Date.now() + config.support.uploadMaxAgeMs);
}

function attachmentExpiry(): Date {
  return new Date(Date.now() + config.support.complaintAttachmentRetentionMs);
}

function complaintRoot(): string {
  return path.join(config.support.storageDir, 'complaints');
}

export function getComplaintUploadDirectory(): string {
  return path.join(complaintRoot(), 'uploads');
}

function getComplaintAttachmentDirectory(): string {
  return path.join(complaintRoot(), 'attachments');
}

export function getComplaintUploadPath(uploadId: string): string {
  return path.join(getComplaintUploadDirectory(), uploadId);
}

export function getComplaintAttachmentPath(storageKey: string): string {
  return path.join(getComplaintAttachmentDirectory(), storageKey);
}

export function ensureComplaintStorage(): void {
  for (const directory of [
    config.support.storageDir,
    complaintRoot(),
    getComplaintUploadDirectory(),
    getComplaintAttachmentDirectory(),
  ]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
}

export async function removeComplaintTusUploadArtifacts(
  uploadId: string
): Promise<void> {
  await Promise.all([
    rm(getComplaintUploadPath(uploadId), { force: true }),
    rm(`${getComplaintUploadPath(uploadId)}.json`, { force: true }),
  ]);
}

export async function ensureComplaintDiskCapacity(
  inputBytes: number
): Promise<void> {
  ensureComplaintStorage();
  const filesystem = await statfs(config.support.storageDir);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = inputBytes + config.support.diskMinimumFreeBytes;
  if (availableBytes < requiredBytes) {
    throw new ComplaintServiceError(
      'INSUFFICIENT_STORAGE',
      'Ruang penyimpanan sementara tidak mencukupi',
      507
    );
  }
}

export function getMainComplaintFeature(
  featureId: string | null | undefined
): (typeof MAIN_COMPLAINT_FEATURES)[number] | null {
  return (
    MAIN_COMPLAINT_FEATURES.find((feature) => feature.id === featureId) ?? null
  );
}

export function getComplaintAttachmentPolicy(
  category: ComplaintCategory,
  featureId: string | null
): ComplaintAttachmentPolicy {
  if (category === 'main_feature') {
    const feature = getMainComplaintFeature(featureId);
    if (!feature) {
      throw new ComplaintServiceError(
        'INVALID_MAIN_FEATURE',
        'Fitur utama tidak valid',
        400
      );
    }
    return {
      maxFiles: 10,
      maxBytesPerFile: feature.maxBytesPerFile,
      acceptedExtensions: ['.pdf'],
    };
  }

  if (category === 'other_feature') {
    return {
      maxFiles: 10,
      maxBytesPerFile: 10 * MIB,
      acceptedExtensions: ['.pdf'],
    };
  }

  return {
    maxFiles: 10,
    maxBytesPerFile: 10 * MIB,
    acceptedExtensions: [
      '.pdf',
      '.docx',
      '.xlsx',
      '.pptx',
      '.txt',
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.mp4',
    ],
  };
}

export function complaintPublicConfig() {
  return {
    mainFeatures: MAIN_COMPLAINT_FEATURES,
    attachmentRetentionHours: Math.round(
      config.support.complaintAttachmentRetentionMs / (60 * 60 * 1000)
    ),
    otherFeature: getComplaintAttachmentPolicy('other_feature', null),
    nonFeature: getComplaintAttachmentPolicy('non_feature', null),
    uploadChunkBytes: config.support.uploadChunkBytes,
  };
}

function newTicketNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `ADU-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function createComplaintDraft(input: {
  reporterId: string;
  reporterUsername: string;
  category: ComplaintCategory;
  featureId: string | null;
  featureName: string | null;
  subject: string;
  contentHtml: string;
  contentText: string;
}): Promise<ComplaintTicket> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `INSERT INTO complaint_tickets (
           ticket_number, reporter_id, reporter_username, category, feature_id,
           feature_name, subject, content_html, content_text, upload_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${TICKET_FIELDS}`,
        [
          newTicketNumber(),
          input.reporterId,
          input.reporterUsername,
          input.category,
          input.featureId,
          input.featureName,
          input.subject,
          input.contentHtml,
          input.contentText,
          draftExpiry(),
        ]
      );
      return mapTicket(result.rows[0]);
    } catch (error) {
      if (
        attempt < 3 &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new ComplaintServiceError(
    'TICKET_NUMBER_UNAVAILABLE',
    'Nomor tiket tidak dapat dibuat. Silakan coba lagi.',
    503
  );
}

async function getOwnedDraftTicket(
  client: PoolClient,
  ticketId: string,
  userId: string,
  lock: boolean = false
): Promise<ComplaintTicket | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${TICKET_FIELDS} FROM complaint_tickets
     WHERE id = $1 AND reporter_id = $2 AND status = 'draft'
     ${lock ? 'FOR UPDATE' : ''}`,
    [ticketId, userId]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function removeExpiredSlotsForTicket(
  client: PoolClient,
  ticketId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `DELETE FROM complaint_upload_slots
     WHERE ticket_id = $1 AND status IN ('ready', 'uploading') AND expires_at <= NOW()
     RETURNING id`,
    [ticketId]
  );
  return result.rows.map((row) => row.id);
}

export async function createComplaintUploadSlot(
  ticketId: string,
  userId: string,
  originalFilename: string,
  expectedBytes: number
): Promise<ComplaintUploadSlot> {
  let expiredSlotIds: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticket = await getOwnedDraftTicket(client, ticketId, userId, true);
    if (!ticket || ticket.uploadExpiresAt.getTime() <= Date.now()) {
      throw new ComplaintServiceError(
        'TICKET_NOT_AVAILABLE',
        'Draft aduan tidak ditemukan atau sudah kedaluwarsa',
        404
      );
    }

    expiredSlotIds = await removeExpiredSlotsForTicket(client, ticket.id);
    const policy = getComplaintAttachmentPolicy(ticket.category, ticket.featureId);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw new ComplaintServiceError(
        'INVALID_FILE_SIZE',
        'Ukuran file tidak valid',
        400
      );
    }
    if (expectedBytes > policy.maxBytesPerFile) {
      throw new ComplaintServiceError(
        'FILE_TOO_LARGE',
        'Ukuran file melampaui batas untuk jenis aduan ini',
        413
      );
    }

    const validatedFile = validateComplaintFileName(
      originalFilename,
      ticket.category
    );

    const count = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM complaint_upload_slots WHERE ticket_id = $1',
      [ticket.id]
    );
    if (Number(count.rows[0].count) >= policy.maxFiles) {
      throw new ComplaintServiceError(
        'TOO_MANY_FILES',
        `Maksimal ${policy.maxFiles} file untuk satu aduan`,
        400
      );
    }

    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO complaint_upload_slots (
         ticket_id, user_id, original_filename, file_kind, expected_bytes, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        ticket.id,
        userId,
        validatedFile.fileName,
        validatedFile.kind,
        expectedBytes,
        slotExpiry(),
      ]
    );
    await client.query(
      `UPDATE complaint_tickets
       SET upload_expires_at = $2, updated_at = NOW() WHERE id = $1`,
      [ticket.id, draftExpiry()]
    );
    const slot = await getComplaintUploadSlotById(
      client,
      String(inserted.rows[0].id),
      userId
    );
    if (!slot) throw new Error('COMPLAINT_UPLOAD_SLOT_NOT_CREATED');
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await Promise.all(
      expiredSlotIds.map((id) => removeComplaintTusUploadArtifacts(id))
    );
  }
}

async function getComplaintUploadSlotById(
  client: PoolClient,
  slotId: string,
  userId: string
): Promise<ComplaintUploadSlot | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${SLOT_FIELDS}
     FROM complaint_upload_slots slots
     INNER JOIN complaint_tickets tickets ON tickets.id = slots.ticket_id
     WHERE slots.id = $1 AND slots.user_id = $2`,
    [slotId, userId]
  );
  return result.rows[0] ? mapSlot(result.rows[0]) : null;
}

export async function getComplaintUploadSlot(
  slotId: string,
  userId: string
): Promise<ComplaintUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE complaint_upload_slots slots
       SET last_activity_at = NOW(),
           expires_at = CASE WHEN slots.status = 'completed' THEN slots.expires_at ELSE $3 END
       FROM complaint_tickets tickets
       WHERE slots.id = $1 AND slots.user_id = $2 AND tickets.id = slots.ticket_id
         AND tickets.status = 'draft'`,
      [slotId, userId, slotExpiry()]
    );
    const slot = await getComplaintUploadSlotById(client, slotId, userId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimComplaintUploadSlot(
  slotId: string,
  userId: string,
  inputBytes: number
): Promise<ComplaintUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ id: string }>(
      `UPDATE complaint_upload_slots slots
       SET status = 'uploading', last_activity_at = NOW(), expires_at = $4
       FROM complaint_tickets tickets
       WHERE slots.id = $1 AND slots.user_id = $2 AND slots.expected_bytes = $3
         AND slots.status = 'ready' AND slots.expires_at > NOW()
         AND tickets.id = slots.ticket_id AND tickets.status = 'draft'
       RETURNING slots.id`,
      [slotId, userId, inputBytes, slotExpiry()]
    );
    if (!updated.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE complaint_tickets
       SET upload_expires_at = $2, updated_at = NOW()
       WHERE id = (SELECT ticket_id FROM complaint_upload_slots WHERE id = $1)`,
      [slotId, draftExpiry()]
    );
    const slot = await getComplaintUploadSlotById(client, slotId, userId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authorizeComplaintUpload(
  slotId: string,
  userId: string
): Promise<ComplaintUploadSlot | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ id: string }>(
      `UPDATE complaint_upload_slots slots
       SET last_activity_at = NOW(), expires_at = $3
       FROM complaint_tickets tickets
       WHERE slots.id = $1 AND slots.user_id = $2 AND slots.status = 'uploading'
         AND slots.expires_at > NOW() AND tickets.id = slots.ticket_id
         AND tickets.status = 'draft'
       RETURNING slots.id`,
      [slotId, userId, slotExpiry()]
    );
    if (!updated.rows[0]) {
      const completed = await getComplaintUploadSlotById(client, slotId, userId);
      await client.query('COMMIT');
      return completed?.status === 'completed' ? completed : null;
    }
    await client.query(
      `UPDATE complaint_tickets
       SET upload_expires_at = $2, updated_at = NOW()
       WHERE id = (SELECT ticket_id FROM complaint_upload_slots WHERE id = $1)`,
      [slotId, draftExpiry()]
    );
    const slot = await getComplaintUploadSlotById(client, slotId, userId);
    await client.query('COMMIT');
    return slot;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetComplaintUploadSlot(
  slotId: string,
  userId: string
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE complaint_upload_slots
     SET status = 'ready', last_activity_at = NOW(), expires_at = $3
     WHERE id = $1 AND user_id = $2 AND status = 'uploading'
     RETURNING id`,
    [slotId, userId, slotExpiry()]
  );
  if (result.rows[0]) await removeComplaintTusUploadArtifacts(slotId);
}

export async function releaseComplaintUploadSlot(
  slotId: string,
  userId: string
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM complaint_upload_slots
     WHERE id = $1 AND user_id = $2 AND status IN ('ready', 'uploading')
     RETURNING id`,
    [slotId, userId]
  );
  if (result.rows[0]) await removeComplaintTusUploadArtifacts(slotId);
}

export async function finalizeComplaintUpload(
  slotId: string,
  userId: string,
  uploadPath: string,
  validatedFile: ValidatedStoredFile
): Promise<ComplaintAttachment> {
  const uploadedFile = await stat(uploadPath);
  let finalPath = '';
  let moved = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slotResult = await client.query<Record<string, unknown>>(
      `SELECT ${SLOT_FIELDS}
       FROM complaint_upload_slots slots
       INNER JOIN complaint_tickets tickets ON tickets.id = slots.ticket_id
       WHERE slots.id = $1 AND slots.user_id = $2 FOR UPDATE`,
      [slotId, userId]
    );
    const slot = slotResult.rows[0] ? mapSlot(slotResult.rows[0]) : null;
    if (
      !slot ||
      slot.status !== 'uploading' ||
      slot.expectedBytes !== uploadedFile.size ||
      slot.fileKind !== validatedFile.kind ||
      slot.originalFilename !== validatedFile.fileName
    ) {
      throw new ComplaintServiceError(
        'UPLOAD_SLOT_UNAVAILABLE',
        'Slot upload tidak lagi tersedia',
        409
      );
    }

    await mkdir(getComplaintAttachmentDirectory(), {
      recursive: true,
      mode: 0o700,
    });
    finalPath = getComplaintAttachmentPath(slot.id);
    await rename(uploadPath, finalPath);
    moved = true;

    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO complaint_attachments (
         id, ticket_id, uploader_id, original_filename, storage_key, file_kind,
         mime_type, size_bytes, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ATTACHMENT_FIELDS}`,
      [
        slot.id,
        slot.ticketId,
        userId,
        validatedFile.fileName,
        slot.id,
        validatedFile.kind,
        validatedFile.mimeType,
        uploadedFile.size,
        attachmentExpiry(),
      ]
    );
    await client.query(
      `UPDATE complaint_upload_slots
       SET status = 'completed', last_activity_at = NOW(), expires_at = $2
       WHERE id = $1`,
      [slot.id, draftExpiry()]
    );
    await client.query(
      'UPDATE complaint_tickets SET updated_at = NOW() WHERE id = $1',
      [slot.ticketId]
    );
    await client.query('COMMIT');
    return mapAttachment(inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (moved && finalPath) await rm(finalPath, { force: true });
    throw error;
  } finally {
    client.release();
  }
}

export async function submitComplaint(
  ticketId: string,
  userId: string
): Promise<ComplaintTicket> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticket = await getOwnedDraftTicket(client, ticketId, userId, true);
    if (!ticket || ticket.uploadExpiresAt.getTime() <= Date.now()) {
      throw new ComplaintServiceError(
        'TICKET_NOT_AVAILABLE',
        'Draft aduan tidak ditemukan atau sudah kedaluwarsa',
        404
      );
    }
    const pending = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM complaint_upload_slots
       WHERE ticket_id = $1 AND status IN ('ready', 'uploading')`,
      [ticket.id]
    );
    if (Number(pending.rows[0].count) > 0) {
      throw new ComplaintServiceError(
        'UPLOADS_INCOMPLETE',
        'Tunggu sampai seluruh lampiran selesai diunggah',
        409
      );
    }
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE complaint_tickets
       SET status = 'open', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'draft'
       RETURNING ${TICKET_FIELDS}`,
      [ticket.id]
    );
    await client.query('COMMIT');
    return mapTicket(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getComplaintAttachmentForOwner(
  ticketId: string,
  attachmentId: string,
  userId: string
): Promise<(ComplaintAttachment & { storagePath: string }) | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${ATTACHMENT_FIELDS}, attachments.storage_key AS "storageKey"
     FROM complaint_attachments attachments
     INNER JOIN complaint_tickets tickets ON tickets.id = attachments.ticket_id
     WHERE attachments.id = $1 AND attachments.ticket_id = $2
       AND tickets.reporter_id = $3 AND attachments.purged_at IS NULL
       AND attachments.expires_at > NOW()`,
    [attachmentId, ticketId, userId]
  );
  if (!result.rows[0]) return null;
  const attachment = mapAttachment(result.rows[0]);
  return {
    ...attachment,
    storagePath: getComplaintAttachmentPath(String(result.rows[0].storageKey)),
  };
}

export async function listAdminComplaints(input: {
  status?: ComplaintStatus;
  search?: string;
  page: number;
  limit: number;
}): Promise<{ tickets: ComplaintTicket[]; total: number }> {
  const search = input.search?.trim() || null;
  const where = `
    status <> 'draft'
    AND ($1::text IS NULL OR status = $1)
    AND (
      $2::text IS NULL OR ticket_number ILIKE $2 OR reporter_username ILIKE $2
      OR subject ILIKE $2 OR COALESCE(feature_name, '') ILIKE $2
    )
  `;
  const searchPattern = search ? `%${search}%` : null;
  const offset = (input.page - 1) * input.limit;
  const [tickets, total] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT ${TICKET_FIELDS} FROM complaint_tickets
       WHERE ${where}
       ORDER BY CASE status
         WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'resolved' THEN 2 ELSE 3
       END, created_at DESC
       LIMIT $3 OFFSET $4`,
      [input.status ?? null, searchPattern, input.limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM complaint_tickets WHERE ${where}`,
      [input.status ?? null, searchPattern]
    ),
  ]);
  return {
    tickets: tickets.rows.map(mapTicket),
    total: Number(total.rows[0].count),
  };
}

export async function getAdminComplaint(
  ticketId: string
): Promise<
  | (ComplaintTicket & {
      attachments: ComplaintAttachment[];
    })
  | null
> {
  const ticketResult = await pool.query<Record<string, unknown>>(
    `SELECT ${TICKET_FIELDS} FROM complaint_tickets
     WHERE id = $1 AND status <> 'draft'`,
    [ticketId]
  );
  if (!ticketResult.rows[0]) return null;
  const attachments = await pool.query<Record<string, unknown>>(
    `SELECT ${ATTACHMENT_FIELDS} FROM complaint_attachments
     WHERE ticket_id = $1 ORDER BY uploaded_at ASC`,
    [ticketId]
  );
  return {
    ...mapTicket(ticketResult.rows[0]),
    attachments: attachments.rows.map(mapAttachment),
  };
}

export async function getComplaintAttachmentForAdmin(
  ticketId: string,
  attachmentId: string
): Promise<(ComplaintAttachment & { storagePath: string }) | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${ATTACHMENT_FIELDS}, attachments.storage_key AS "storageKey"
     FROM complaint_attachments attachments
     INNER JOIN complaint_tickets tickets ON tickets.id = attachments.ticket_id
     WHERE attachments.id = $1 AND attachments.ticket_id = $2
       AND tickets.status <> 'draft' AND attachments.purged_at IS NULL
       AND attachments.expires_at > NOW()`,
    [attachmentId, ticketId]
  );
  if (!result.rows[0]) return null;
  const attachment = mapAttachment(result.rows[0]);
  return {
    ...attachment,
    storagePath: getComplaintAttachmentPath(String(result.rows[0].storageKey)),
  };
}

export async function changeComplaintStatus(
  ticketId: string,
  status: Extract<ComplaintStatus, 'open' | 'in_progress'>,
  _adminId: string
): Promise<ComplaintTicket | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE complaint_tickets
     SET status = $2, updated_at = NOW(),
         resolved_at = NULL, resolved_by = NULL,
         resolution_html = NULL, resolution_text = NULL
     WHERE id = $1 AND status <> 'draft'
     RETURNING ${TICKET_FIELDS}`,
    [ticketId, status]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

export async function resolveComplaint(
  ticketId: string,
  adminId: string,
  resolutionHtml: string,
  resolutionText: string
): Promise<ComplaintTicket | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE complaint_tickets
     SET status = 'resolved', resolved_at = NOW(), resolved_by = $2,
         resolution_html = $3, resolution_text = $4, updated_at = NOW()
     WHERE id = $1 AND status IN ('open', 'in_progress', 'resolved')
     RETURNING ${TICKET_FIELDS}`,
    [ticketId, adminId, resolutionHtml, resolutionText]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

export async function cleanupExpiredComplaintAssets(): Promise<void> {
  ensureComplaintStorage();
  const expiredAttachments = await pool.query<{ storageKey: string }>(
    `UPDATE complaint_attachments
     SET purged_at = NOW()
     WHERE purged_at IS NULL AND expires_at <= NOW()
     RETURNING storage_key AS "storageKey"`
  );
  await Promise.all(
    expiredAttachments.rows.map(({ storageKey }) =>
      rm(getComplaintAttachmentPath(storageKey), { force: true })
    )
  );

  const expiredSlots = await pool.query<{ id: string }>(
    `DELETE FROM complaint_upload_slots
     WHERE status IN ('ready', 'uploading') AND expires_at <= NOW()
     RETURNING id`
  );
  await Promise.all(
    expiredSlots.rows.map(({ id }) => removeComplaintTusUploadArtifacts(id))
  );

  const client = await pool.connect();
  let staleAttachmentKeys: string[] = [];
  let staleSlotIds: string[] = [];
  try {
    await client.query('BEGIN');
    const drafts = await client.query<{ id: string }>(
      `SELECT id FROM complaint_tickets
       WHERE status = 'draft' AND upload_expires_at <= NOW()
       FOR UPDATE SKIP LOCKED`
    );
    const ticketIds = drafts.rows.map((row) => row.id);
    if (ticketIds.length > 0) {
      const [attachments, slots] = await Promise.all([
        client.query<{ storageKey: string }>(
          `SELECT storage_key AS "storageKey" FROM complaint_attachments
           WHERE ticket_id = ANY($1::uuid[])`,
          [ticketIds]
        ),
        client.query<{ id: string }>(
          `SELECT id FROM complaint_upload_slots WHERE ticket_id = ANY($1::uuid[])`,
          [ticketIds]
        ),
      ]);
      staleAttachmentKeys = attachments.rows.map((row) => row.storageKey);
      staleSlotIds = slots.rows.map((row) => row.id);
      await client.query(
        'DELETE FROM complaint_tickets WHERE id = ANY($1::uuid[])',
        [ticketIds]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await Promise.all([
    ...staleAttachmentKeys.map((key) =>
      rm(getComplaintAttachmentPath(key), { force: true })
    ),
    ...staleSlotIds.map((id) => removeComplaintTusUploadArtifacts(id)),
  ]);
}
