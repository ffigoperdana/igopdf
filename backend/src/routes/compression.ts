import { rm } from 'node:fs/promises';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { compressionControlLimiter } from '../middleware/rateLimiter.js';
import {
  deleteCompletedJob,
  ensureCompressionStorage,
  getCompressionUploadSlot,
  getJobForUser,
  getJobInputPath,
  getJobOutputPath,
  getQueuePosition,
  releaseCompressionUploadSlot,
  requestJobCancellation,
  reserveCompressionUploadSlot,
  resetCompressionUploadSlot,
} from '../services/compressionJobService.js';
import { logger } from '../utils/logger.js';

const router = Router();
const jobIdSchema = z.string().uuid();
const uploadSlotIdSchema = z.string().uuid();
const createSlotSchema = z.object({
  mode: z.enum(['lossless', 'balanced']),
  inputBytes: z.number().int().positive().safe(),
});

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;
const asyncRoute =
  (handler: AsyncRoute) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };

ensureCompressionStorage();

router.use(authMiddleware);
router.use(compressionControlLimiter);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      enabled: config.compression.enabled,
      clientThresholdBytes: config.compression.clientThresholdBytes,
      balancedMaxBytes: config.compression.balancedMaxBytes,
      maxUploadBytes: config.compression.maxUploadBytes,
      uploadChunkBytes: config.compression.uploadChunkBytes,
    },
  });
});

router.post(
  '/upload-slots',
  asyncRoute(async (req, res) => {
    if (!config.compression.enabled) {
      res.status(503).json({
        success: false,
        error: 'Server-side compression is unavailable',
      });
      return;
    }
    const validation = createSlotSchema.safeParse(req.body);
    if (!validation.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid compression upload request' });
      return;
    }

    const { mode, inputBytes } = validation.data;
    if (inputBytes <= config.compression.clientThresholdBytes) {
      res.status(400).json({
        success: false,
        error: 'This file should be compressed in the browser',
      });
      return;
    }
    if (inputBytes > config.compression.maxUploadBytes) {
      res
        .status(413)
        .json({ success: false, error: 'Maximum upload size is 1 GB' });
      return;
    }
    if (
      mode === 'balanced' &&
      inputBytes > config.compression.balancedMaxBytes
    ) {
      res.status(400).json({
        success: false,
        error: 'Balanced compression is limited to 500 MB',
      });
      return;
    }

    try {
      const slot = await reserveCompressionUploadSlot(
        req.user!.id,
        mode,
        inputBytes
      );
      res.status(201).json({ success: true, data: { slot } });
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_UPLOAD_EXISTS') {
        res.status(409).json({
          success: false,
          error: 'Finish or cancel your existing large-file compression first',
        });
        return;
      }
      throw error;
    }
  })
);

router.get(
  '/upload-slots/:id',
  asyncRoute(async (req, res) => {
    const parsed = uploadSlotIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid upload slot id' });
      return;
    }
    const slot = await getCompressionUploadSlot(parsed.data, req.user!.id);
    if (!slot) {
      res
        .status(404)
        .json({ success: false, error: 'Upload queue reservation expired' });
      return;
    }
    res.json({ success: true, data: { slot } });
  })
);

router.post(
  '/upload-slots/:id/reset',
  asyncRoute(async (req, res) => {
    const parsed = uploadSlotIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid upload slot id' });
      return;
    }
    const slot = await resetCompressionUploadSlot(parsed.data, req.user!.id);
    if (!slot) {
      res.status(409).json({
        success: false,
        error: 'This upload can no longer be restarted',
      });
      return;
    }
    res.json({ success: true, data: { slot } });
  })
);

router.delete(
  '/upload-slots/:id',
  asyncRoute(async (req, res) => {
    const parsed = uploadSlotIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid upload slot id' });
      return;
    }
    await releaseCompressionUploadSlot(parsed.data, req.user!.id);
    res.status(204).end();
  })
);

router.get(
  '/jobs/:id',
  asyncRoute(async (req, res) => {
    const parsed = jobIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid job id' });
      return;
    }
    const job = await getJobForUser(parsed.data, req.user!.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Job not found' });
      return;
    }
    if (job.expiresAt.getTime() <= Date.now()) {
      await deleteCompletedJob(job.id, req.user!.id);
      res.status(410).json({ success: false, error: 'Job result has expired' });
      return;
    }
    res.json({
      success: true,
      data: { job, queuePosition: await getQueuePosition(job) },
    });
  })
);

router.delete(
  '/jobs/:id',
  asyncRoute(async (req, res) => {
    const parsed = jobIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid job id' });
      return;
    }
    const job = await requestJobCancellation(parsed.data, req.user!.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Active job not found' });
      return;
    }
    if (job.status === 'cancelled' && !job.startedAt) {
      await Promise.all([
        rm(getJobInputPath(job.id), { force: true }),
        rm(getJobOutputPath(job.id), { force: true }),
      ]);
    }
    res.json({ success: true, data: { job } });
  })
);

router.get(
  '/jobs/:id/download',
  asyncRoute(async (req, res) => {
    const parsed = jobIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid job id' });
      return;
    }
    const job = await getJobForUser(parsed.data, req.user!.id);
    if (!job || job.status !== 'completed') {
      res
        .status(404)
        .json({ success: false, error: 'Completed job not found' });
      return;
    }
    if (job.expiresAt.getTime() <= Date.now()) {
      await deleteCompletedJob(job.id, req.user!.id);
      res.status(410).json({ success: false, error: 'Job result has expired' });
      return;
    }

    res.download(
      getJobOutputPath(job.id),
      'igo-compressed.pdf',
      async (error) => {
        if (!error) await deleteCompletedJob(job.id, req.user!.id);
      }
    );
  })
);

router.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Compression route failed', {
      reason: error instanceof Error ? error.message : 'UNKNOWN',
    });
    res
      .status(500)
      .json({ success: false, error: 'Compression service error' });
  }
);

export default router;
