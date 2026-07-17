import { open } from 'node:fs/promises';
import type { Request as ExpressRequest } from 'express';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server, type ServerOptions, type Upload } from '@tus/server';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  authorizeDocxUpload,
  claimDocxUploadSlot,
  ensureDocxDiskCapacity,
  ensureDocxStorage,
  finalizeDocxUpload,
  getDocxUploadDirectory,
  getDocxUploadPath,
  getDocxUploadSlot,
  releaseDocxUploadSlot,
  resetDocxUploadSlot,
  type DocxMode,
} from './docxJobService.js';
import { logger } from '../utils/logger.js';

const uploadIdSchema = z.string().uuid();
const modeSchema = z.enum(['editable', 'ocr', 'visual']);
type TusRequest = Parameters<NonNullable<ServerOptions['onUploadCreate']>>[0];

function protocolError(statusCode: number, body: string): never {
  throw { status_code: statusCode, body: `${body}\n` };
}

function getExpressRequest(request: TusRequest): ExpressRequest {
  const nodeRequest = (request as unknown as { runtime?: { node?: { req?: ExpressRequest } } }).runtime?.node?.req;
  if (!nodeRequest?.user) protocolError(401, 'Authentication required');
  return nodeRequest;
}

function getMetadataValue(metadata: Upload['metadata'], key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function parseIdentity(metadata: Upload['metadata']): { slotId: string; mode: DocxMode } {
  const slotId = uploadIdSchema.safeParse(getMetadataValue(metadata, 'slotId'));
  const mode = modeSchema.safeParse(getMetadataValue(metadata, 'mode'));
  if (!slotId.success || !mode.success) protocolError(400, 'Invalid DOCX upload metadata');
  return { slotId: slotId.data, mode: mode.data };
}

async function isPdfFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead).includes(Buffer.from('%PDF-', 'ascii'));
  } finally {
    await handle.close();
  }
}

ensureDocxStorage();

export const docxFileStore = new FileStore({
  directory: getDocxUploadDirectory(),
  expirationPeriodInMilliseconds: config.docx.uploadMaxAgeMs,
});

export const docxTusServer = new Server({
  path: '/api/docx/uploads',
  datastore: docxFileStore,
  maxSize: config.docx.maxUploadBytes,
  relativeLocation: true,
  respectForwardedHeaders: true,
  allowedCredentials: true,
  allowedOrigins: [config.cors.origin],
  exposedHeaders: ['Upload-Job-Id'],
  namingFunction: (_request, metadata) => {
    const parsed = uploadIdSchema.safeParse(metadata?.slotId);
    if (!parsed.success) protocolError(400, 'Invalid DOCX upload slot');
    return parsed.data;
  },
  onIncomingRequest: async (request, uploadId) => {
    const expressRequest = getExpressRequest(request);
    const parsed = uploadIdSchema.safeParse(uploadId);
    if (!parsed.success) protocolError(400, 'Invalid upload id');
    if (request.method === 'POST') {
      const slot = await getDocxUploadSlot(parsed.data, expressRequest.user!.id);
      if (!slot) protocolError(404, 'Upload reservation expired');
      if (slot.status !== 'ready') {
        protocolError(409, slot.status === 'uploading' ? 'Upload already exists; resume the existing upload URL' : 'Upload has already been queued');
      }
      return;
    }
    const slot = await authorizeDocxUpload(parsed.data, expressRequest.user!.id);
    if (!slot) protocolError(404, 'Upload not found or no longer belongs to this session');
  },
  onUploadCreate: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const { slotId, mode } = parseIdentity(upload.metadata);
    if (slotId !== upload.id || !Number.isSafeInteger(upload.size)) {
      protocolError(400, 'Invalid upload length');
    }
    const inputBytes = upload.size as number;
    if (inputBytes > config.docx.maxUploadBytes) {
      protocolError(413, 'Maximum DOCX conversion upload is 50 MB');
    }
    try {
      await ensureDocxDiskCapacity(inputBytes);
    } catch (error) {
      if (error instanceof Error && error.message === 'INSUFFICIENT_STORAGE') {
        protocolError(507, 'The DOCX conversion server does not have enough temporary disk space');
      }
      throw error;
    }
    const slot = await claimDocxUploadSlot(slotId, expressRequest.user!.id, mode, inputBytes);
    if (!slot) protocolError(409, 'This upload reservation is no longer ready');
    return { metadata: { slotId, mode, filetype: 'application/pdf' } };
  },
  onUploadFinish: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const { slotId, mode } = parseIdentity(upload.metadata);
    const uploadPath = getDocxUploadPath(upload.id);
    try {
      if (!(await isPdfFile(uploadPath))) protocolError(415, 'The uploaded file is not a valid PDF');
      const job = await finalizeDocxUpload(expressRequest.user!.id, mode, uploadPath, slotId);
      await docxFileStore.configstore.delete(upload.id).catch((): undefined => undefined);
      logger.info('Resumable DOCX upload completed', { jobId: job.id, inputBytes: job.inputBytes, mode: job.mode });
      return { headers: { 'Upload-Job-Id': job.id } };
    } catch (error) {
      await resetDocxUploadSlot(slotId, expressRequest.user!.id).catch((): undefined => undefined);
      logger.warn('Resumable DOCX upload finalization failed', { uploadId: upload.id, reason: error instanceof Error ? error.message : 'UPLOAD_FINALIZATION_FAILED' });
      throw error;
    }
  },
  onResponseError: async (request, error) => {
    logger.warn('Resumable DOCX request rejected', { method: request.method, statusCode: 'status_code' in error ? error.status_code : undefined });
    return undefined;
  },
});

docxTusServer.on(EVENTS.POST_TERMINATE, (request, _response, uploadId) => {
  try {
    const expressRequest = getExpressRequest(request as TusRequest);
    void releaseDocxUploadSlot(uploadId, expressRequest.user!.id);
  } catch {
    // The protocol response is finished; expiry cleanup will remove stale data.
  }
});

const cleanupTimer = setInterval(() => {
  void docxTusServer.cleanUpExpiredUploads().catch((error: unknown) => {
    logger.warn('Could not clean expired DOCX uploads', { reason: error instanceof Error ? error.message : 'UNKNOWN' });
  });
}, 10 * 60 * 1000);
cleanupTimer.unref();
