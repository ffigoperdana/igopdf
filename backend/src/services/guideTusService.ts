import type { Request as ExpressRequest } from 'express';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server, type ServerOptions, type Upload } from '@tus/server';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  GuideServiceError,
  authorizeGuideUpload,
  claimGuideUploadSlot,
  ensureGuideDiskCapacity,
  ensureGuideStorage,
  finalizeGuideUpload,
  getGuideUploadDirectory,
  getGuideUploadPath,
  getGuideUploadSlot,
  removeGuideTusUploadArtifacts,
  releaseGuideUploadSlot,
  resetGuideUploadSlot,
} from './guideService.js';
import {
  FileValidationError,
  assertFileMatchesKind,
  validateGuideFileName,
} from '../utils/fileValidation.js';
import { MalwareScanError, scanFileForMalware } from './malwareScanService.js';
import { logger } from '../utils/logger.js';

const uploadIdSchema = z.string().uuid();
const maxGuideUploadBytes = Math.max(
  config.support.guidePdfMaxBytes,
  config.support.guideVideoMaxBytes,
  config.support.guidePptxMaxBytes
);
type TusRequest = Parameters<NonNullable<ServerOptions['onUploadCreate']>>[0];

function protocolError(statusCode: number, body: string): never {
  throw { status_code: statusCode, body: `${body}\n` };
}

function getAdminRequest(request: TusRequest): ExpressRequest {
  const nodeRequest = (
    request as unknown as {
      runtime?: { node?: { req?: ExpressRequest } };
    }
  ).runtime?.node?.req;
  if (!nodeRequest?.user) protocolError(401, 'Authentication required');
  if (nodeRequest.user.role !== 'admin')
    protocolError(403, 'Admin access required');
  return nodeRequest;
}

function metadataValue(
  metadata: Upload['metadata'],
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function parseSlotId(metadata: Upload['metadata']): string {
  const parsed = uploadIdSchema.safeParse(metadataValue(metadata, 'slotId'));
  if (!parsed.success) protocolError(400, 'Invalid guide upload metadata');
  return parsed.data;
}

function protocolErrorFrom(error: unknown): never {
  if (error instanceof GuideServiceError) {
    protocolError(error.statusCode, error.message);
  }
  if (error instanceof FileValidationError) {
    protocolError(415, error.message);
  }
  if (error instanceof MalwareScanError) {
    protocolError(error.statusCode, error.message);
  }
  throw error;
}

ensureGuideStorage();

export const guideFileStore = new FileStore({
  directory: getGuideUploadDirectory(),
  expirationPeriodInMilliseconds: config.support.uploadMaxAgeMs,
});

export const guideTusServer = new Server({
  path: '/api/guides/uploads',
  datastore: guideFileStore,
  maxSize: maxGuideUploadBytes,
  relativeLocation: true,
  respectForwardedHeaders: true,
  allowedCredentials: true,
  allowedOrigins: [config.cors.origin],
  exposedHeaders: ['Upload-Guide-Id'],
  namingFunction: (_request, metadata) => parseSlotId(metadata),
  onIncomingRequest: async (request, uploadId) => {
    const expressRequest = getAdminRequest(request);
    const parsed = uploadIdSchema.safeParse(uploadId);
    if (!parsed.success) protocolError(400, 'Invalid upload id');
    if (request.method === 'POST') {
      const slot = await getGuideUploadSlot(
        parsed.data,
        expressRequest.user!.id
      );
      if (!slot) protocolError(404, 'Upload reservation expired');
      if (slot.status !== 'ready') {
        protocolError(
          409,
          slot.status === 'uploading'
            ? 'Upload already exists; resume the existing upload URL'
            : 'Upload has already completed'
        );
      }
      return;
    }
    const slot = await authorizeGuideUpload(
      parsed.data,
      expressRequest.user!.id
    );
    if (!slot) {
      protocolError(
        404,
        'Upload not found or no longer belongs to this session'
      );
    }
  },
  onUploadCreate: async (request, upload) => {
    const expressRequest = getAdminRequest(request);
    const slotId = parseSlotId(upload.metadata);
    if (slotId !== upload.id || !Number.isSafeInteger(upload.size)) {
      protocolError(400, 'Invalid upload length');
    }
    const inputBytes = upload.size as number;
    if (inputBytes <= 0 || inputBytes > maxGuideUploadBytes) {
      protocolError(413, 'Guide material is too large');
    }
    try {
      await ensureGuideDiskCapacity(inputBytes);
      const slot = await claimGuideUploadSlot(
        slotId,
        expressRequest.user!.id,
        inputBytes
      );
      if (!slot)
        protocolError(409, 'This upload reservation is no longer ready');
      return {
        metadata: { slotId, filetype: 'application/octet-stream' },
      };
    } catch (error) {
      protocolErrorFrom(error);
    }
  },
  onUploadFinish: async (request, upload) => {
    const expressRequest = getAdminRequest(request);
    const slotId = parseSlotId(upload.metadata);
    const uploadPath = getGuideUploadPath(upload.id);
    try {
      const slot = await getGuideUploadSlot(slotId, expressRequest.user!.id);
      if (!slot || slot.status !== 'uploading') {
        protocolError(409, 'This upload reservation is no longer active');
      }
      const expected = validateGuideFileName(
        slot.originalFilename,
        slot.assetType
      );
      await scanFileForMalware(uploadPath);
      const validatedFile = await assertFileMatchesKind(uploadPath, expected);
      const guide = await finalizeGuideUpload(
        slotId,
        expressRequest.user!.id,
        uploadPath,
        validatedFile
      );
      await guideFileStore.configstore
        .delete(upload.id)
        .catch((): undefined => undefined);
      logger.info('Guide upload completed', {
        guideId: guide.id,
        sizeBytes: guide.sizeBytes,
      });
      return { headers: { 'Upload-Guide-Id': guide.id } };
    } catch (error) {
      if (
        error instanceof FileValidationError ||
        error instanceof MalwareScanError
      ) {
        await removeGuideTusUploadArtifacts(upload.id).catch(
          (): undefined => undefined
        );
        await guideFileStore.configstore
          .delete(upload.id)
          .catch((): undefined => undefined);
      }
      await resetGuideUploadSlot(slotId, expressRequest.user!.id).catch(
        (): undefined => undefined
      );
      logger.warn('Guide upload finalization failed', {
        uploadId: upload.id,
        reason:
          error instanceof Error ? error.message : 'UPLOAD_FINALIZATION_FAILED',
      });
      protocolErrorFrom(error);
    }
  },
  onResponseError: async (request, error) => {
    logger.warn('Guide upload request rejected', {
      method: request.method,
      statusCode: 'status_code' in error ? error.status_code : undefined,
    });
    return undefined;
  },
});

guideTusServer.on(EVENTS.POST_TERMINATE, (request, _response, uploadId) => {
  try {
    const expressRequest = getAdminRequest(request as TusRequest);
    void releaseGuideUploadSlot(uploadId, expressRequest.user!.id);
  } catch {
    // The protocol response is already complete; expiry cleanup handles stale data.
  }
});

const cleanupTimer = setInterval(
  () => {
    void guideTusServer.cleanUpExpiredUploads().catch((error: unknown) => {
      logger.warn('Could not clean expired guide uploads', {
        reason: error instanceof Error ? error.message : 'UNKNOWN',
      });
    });
  },
  10 * 60 * 1000
);
cleanupTimer.unref();
