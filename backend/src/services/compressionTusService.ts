import { open } from 'node:fs/promises';
import type { Request as ExpressRequest } from 'express';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server, type ServerOptions, type Upload } from '@tus/server';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  authorizeCompressionUpload,
  claimCompressionUploadSlot,
  ensureCompressionDiskCapacity,
  ensureCompressionStorage,
  finalizeResumableCompressionUpload,
  getCompressionUploadSlot,
  getTusUploadDirectory,
  getTusUploadPath,
  releaseCompressionUploadSlot,
  resetCompressionUploadSlot,
  type CompressionMode,
} from './compressionJobService.js';
import { logger } from '../utils/logger.js';

const uploadIdSchema = z.string().uuid();
const modeSchema = z.enum(['lossless', 'balanced']);

type TusRequest = Parameters<NonNullable<ServerOptions['onUploadCreate']>>[0];

function protocolError(statusCode: number, body: string): never {
  throw { status_code: statusCode, body: `${body}\n` };
}

function getExpressRequest(request: TusRequest): ExpressRequest {
  const nodeRequest = (
    request as unknown as {
      runtime?: { node?: { req?: ExpressRequest } };
    }
  ).runtime?.node?.req;
  if (!nodeRequest?.user) protocolError(401, 'Authentication required');
  return nodeRequest;
}

function getMetadataValue(
  metadata: Upload['metadata'],
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function parseUploadIdentity(metadata: Upload['metadata']): {
  slotId: string;
  mode: CompressionMode;
} {
  const slotId = uploadIdSchema.safeParse(getMetadataValue(metadata, 'slotId'));
  const mode = modeSchema.safeParse(getMetadataValue(metadata, 'mode'));
  if (!slotId.success || !mode.success) {
    protocolError(400, 'Invalid resumable upload metadata');
  }
  return { slotId: slotId.data, mode: mode.data };
}

async function isPdfFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header
      .subarray(0, bytesRead)
      .includes(Buffer.from('%PDF-', 'ascii'));
  } finally {
    await handle.close();
  }
}

ensureCompressionStorage();

export const compressionFileStore = new FileStore({
  directory: getTusUploadDirectory(),
  expirationPeriodInMilliseconds: config.compression.uploadMaxAgeMs,
});

export const compressionTusServer = new Server({
  path: '/api/compression/uploads',
  datastore: compressionFileStore,
  maxSize: config.compression.maxUploadBytes,
  relativeLocation: true,
  respectForwardedHeaders: true,
  allowedCredentials: true,
  allowedOrigins: [config.cors.origin],
  exposedHeaders: ['Upload-Job-Id'],
  namingFunction: (_request, metadata) => {
    const parsed = uploadIdSchema.safeParse(metadata?.slotId);
    if (!parsed.success) protocolError(400, 'Invalid upload slot id');
    return parsed.data;
  },
  onIncomingRequest: async (request, uploadId) => {
    const expressRequest = getExpressRequest(request);
    const parsed = uploadIdSchema.safeParse(uploadId);
    if (!parsed.success) protocolError(400, 'Invalid upload id');

    if (request.method === 'POST') {
      const slot = await getCompressionUploadSlot(
        parsed.data,
        expressRequest.user!.id
      );
      if (!slot) protocolError(404, 'Upload queue reservation expired');
      if (slot.status !== 'ready' || slot.queuePosition !== 1) {
        protocolError(
          409,
          slot.status === 'uploading'
            ? 'Upload already exists; resume the existing upload URL'
            : 'Waiting for an earlier compression upload'
        );
      }
      return;
    }

    const slot = await authorizeCompressionUpload(
      parsed.data,
      expressRequest.user!.id
    );
    if (!slot)
      protocolError(
        404,
        'Upload not found or no longer belongs to this session'
      );
  },
  onUploadCreate: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const { slotId, mode } = parseUploadIdentity(upload.metadata);
    if (slotId !== upload.id || !Number.isSafeInteger(upload.size)) {
      protocolError(400, 'Invalid upload length');
    }
    const inputBytes = upload.size as number;
    if (
      inputBytes <= config.compression.clientThresholdBytes ||
      inputBytes > config.compression.maxUploadBytes
    ) {
      protocolError(413, 'Upload size is outside the server compression range');
    }
    if (
      mode === 'balanced' &&
      inputBytes > config.compression.balancedMaxBytes
    ) {
      protocolError(400, 'Balanced compression is limited to 500 MB');
    }

    try {
      await ensureCompressionDiskCapacity(inputBytes);
    } catch (error) {
      if (error instanceof Error && error.message === 'INSUFFICIENT_STORAGE') {
        protocolError(
          507,
          'The compression server does not have enough temporary disk space'
        );
      }
      throw error;
    }

    const claimed = await claimCompressionUploadSlot(
      slotId,
      expressRequest.user!.id,
      mode,
      inputBytes
    );
    if (!claimed) protocolError(409, 'The upload queue slot is not ready');

    return {
      metadata: {
        slotId,
        mode,
        filetype: 'application/pdf',
      },
    };
  },
  onUploadFinish: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const { slotId, mode } = parseUploadIdentity(upload.metadata);
    const uploadPath = getTusUploadPath(upload.id);

    try {
      if (!(await isPdfFile(uploadPath))) {
        protocolError(415, 'The uploaded file is not a valid PDF');
      }
      const job = await finalizeResumableCompressionUpload(
        expressRequest.user!.id,
        mode,
        uploadPath,
        slotId
      );
      await compressionFileStore.configstore
        .delete(upload.id)
        .catch((): undefined => undefined);
      logger.info('Resumable compression upload completed', {
        jobId: job.id,
        inputBytes: job.inputBytes,
        mode: job.mode,
      });
      return { headers: { 'Upload-Job-Id': job.id } };
    } catch (error) {
      await resetCompressionUploadSlot(slotId, expressRequest.user!.id).catch(
        (): undefined => undefined
      );
      logger.warn('Resumable compression upload finalization failed', {
        uploadId: upload.id,
        reason:
          error instanceof Error ? error.message : 'UPLOAD_FINALIZATION_FAILED',
      });
      throw error;
    }
  },
  onResponseError: async (request, error) => {
    logger.warn('Resumable compression request rejected', {
      method: request.method,
      statusCode: 'status_code' in error ? error.status_code : undefined,
    });
    return undefined;
  },
});

compressionTusServer.on(
  EVENTS.POST_TERMINATE,
  (request, _response, uploadId) => {
    try {
      const expressRequest = getExpressRequest(request as TusRequest);
      void releaseCompressionUploadSlot(uploadId, expressRequest.user!.id);
    } catch {
      // The protocol response has already completed; stale files are also removed by expiry cleanup.
    }
  }
);

const cleanupTimer = setInterval(
  () => {
    void compressionTusServer
      .cleanUpExpiredUploads()
      .catch((error: unknown) => {
        logger.warn('Could not clean expired resumable uploads', {
          reason: error instanceof Error ? error.message : 'UNKNOWN',
        });
      });
  },
  10 * 60 * 1000
);
cleanupTimer.unref();
