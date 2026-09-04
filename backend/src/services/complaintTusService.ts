import type { Request as ExpressRequest } from 'express';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server, type ServerOptions, type Upload } from '@tus/server';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  MAIN_COMPLAINT_FEATURES,
  ComplaintServiceError,
  authorizeComplaintUpload,
  claimComplaintUploadSlot,
  ensureComplaintDiskCapacity,
  ensureComplaintStorage,
  finalizeComplaintUpload,
  getComplaintUploadDirectory,
  getComplaintUploadPath,
  getComplaintUploadSlot,
  removeComplaintTusUploadArtifacts,
  releaseComplaintUploadSlot,
  resetComplaintUploadSlot,
} from './complaintService.js';
import {
  FileValidationError,
  assertFileMatchesKind,
  validateComplaintFileName,
} from '../utils/fileValidation.js';
import { MalwareScanError, scanFileForMalware } from './malwareScanService.js';
import { logger } from '../utils/logger.js';

const uploadIdSchema = z.string().uuid();
const maxComplaintUploadBytes = Math.max(
  ...MAIN_COMPLAINT_FEATURES.map((feature) => feature.maxBytesPerFile)
);
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

function metadataValue(metadata: Upload['metadata'], key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function parseSlotId(metadata: Upload['metadata']): string {
  const parsed = uploadIdSchema.safeParse(metadataValue(metadata, 'slotId'));
  if (!parsed.success) protocolError(400, 'Invalid complaint upload metadata');
  return parsed.data;
}

function protocolErrorFrom(error: unknown): never {
  if (error instanceof ComplaintServiceError) {
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

ensureComplaintStorage();

export const complaintFileStore = new FileStore({
  directory: getComplaintUploadDirectory(),
  expirationPeriodInMilliseconds: config.support.uploadMaxAgeMs,
});

export const complaintTusServer = new Server({
  path: '/api/complaints/uploads',
  datastore: complaintFileStore,
  maxSize: maxComplaintUploadBytes,
  relativeLocation: true,
  respectForwardedHeaders: true,
  allowedCredentials: true,
  allowedOrigins: [config.cors.origin],
  exposedHeaders: ['Upload-Attachment-Id'],
  namingFunction: (_request, metadata) => parseSlotId(metadata),
  onIncomingRequest: async (request, uploadId) => {
    const expressRequest = getExpressRequest(request);
    const parsed = uploadIdSchema.safeParse(uploadId);
    if (!parsed.success) protocolError(400, 'Invalid upload id');
    if (request.method === 'POST') {
      const slot = await getComplaintUploadSlot(parsed.data, expressRequest.user!.id);
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
    const slot = await authorizeComplaintUpload(parsed.data, expressRequest.user!.id);
    if (!slot) {
      protocolError(404, 'Upload not found or no longer belongs to this session');
    }
  },
  onUploadCreate: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const slotId = parseSlotId(upload.metadata);
    if (slotId !== upload.id || !Number.isSafeInteger(upload.size)) {
      protocolError(400, 'Invalid upload length');
    }
    const inputBytes = upload.size as number;
    if (inputBytes <= 0 || inputBytes > maxComplaintUploadBytes) {
      protocolError(413, 'Upload size is outside the allowed range');
    }
    try {
      await ensureComplaintDiskCapacity(inputBytes);
      const slot = await claimComplaintUploadSlot(
        slotId,
        expressRequest.user!.id,
        inputBytes
      );
      if (!slot) protocolError(409, 'This upload reservation is no longer ready');
      return {
        metadata: {
          slotId,
          filetype: 'application/octet-stream',
        },
      };
    } catch (error) {
      protocolErrorFrom(error);
    }
  },
  onUploadFinish: async (request, upload) => {
    const expressRequest = getExpressRequest(request);
    const slotId = parseSlotId(upload.metadata);
    const uploadPath = getComplaintUploadPath(upload.id);
    try {
      const slot = await getComplaintUploadSlot(slotId, expressRequest.user!.id);
      if (!slot || slot.status !== 'uploading') {
        protocolError(409, 'This upload reservation is no longer active');
      }
      const expected = validateComplaintFileName(
        slot.originalFilename,
        slot.category
      );
      await scanFileForMalware(uploadPath);
      const validatedFile = await assertFileMatchesKind(uploadPath, expected);
      const attachment = await finalizeComplaintUpload(
        slotId,
        expressRequest.user!.id,
        uploadPath,
        validatedFile
      );
      await complaintFileStore.configstore
        .delete(upload.id)
        .catch((): undefined => undefined);
      logger.info('Complaint attachment upload completed', {
        attachmentId: attachment.id,
        ticketId: attachment.ticketId,
        sizeBytes: attachment.sizeBytes,
      });
      return { headers: { 'Upload-Attachment-Id': attachment.id } };
    } catch (error) {
      if (error instanceof FileValidationError || error instanceof MalwareScanError) {
        await removeComplaintTusUploadArtifacts(upload.id).catch(
          (): undefined => undefined
        );
        await complaintFileStore.configstore
          .delete(upload.id)
          .catch((): undefined => undefined);
      }
      await resetComplaintUploadSlot(slotId, expressRequest.user!.id).catch(
        (): undefined => undefined
      );
      logger.warn('Complaint upload finalization failed', {
        uploadId: upload.id,
        reason: error instanceof Error ? error.message : 'UPLOAD_FINALIZATION_FAILED',
      });
      protocolErrorFrom(error);
    }
  },
  onResponseError: async (request, error) => {
    logger.warn('Complaint upload request rejected', {
      method: request.method,
      statusCode: 'status_code' in error ? error.status_code : undefined,
    });
    return undefined;
  },
});

complaintTusServer.on(EVENTS.POST_TERMINATE, (request, _response, uploadId) => {
  try {
    const expressRequest = getExpressRequest(request as TusRequest);
    void releaseComplaintUploadSlot(uploadId, expressRequest.user!.id);
  } catch {
    // The protocol response is already complete; expiry cleanup handles stale data.
  }
});

const cleanupTimer = setInterval(() => {
  void complaintTusServer.cleanUpExpiredUploads().catch((error: unknown) => {
    logger.warn('Could not clean expired complaint uploads', {
      reason: error instanceof Error ? error.message : 'UNKNOWN',
    });
  });
}, 10 * 60 * 1000);
cleanupTimer.unref();
