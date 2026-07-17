import { rm } from 'node:fs/promises';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { compressionControlLimiter } from '../middleware/rateLimiter.js';
import {
  deleteCompletedDocxJob,
  ensureDocxStorage,
  getDocxJobForUser,
  getDocxJobInputPath,
  getDocxJobOutputPath,
  getDocxQueuePosition,
  getDocxUploadSlot,
  releaseDocxUploadSlot,
  reserveDocxUploadSlot,
  requestDocxCancellation,
  type DocxMode,
} from '../services/docxJobService.js';
import { logger } from '../utils/logger.js';

const router = Router();
const idSchema = z.string().uuid();
const createSlotSchema = z.object({
  mode: z.enum(['editable', 'ocr', 'visual']),
  inputBytes: z.number().int().positive().safe(),
});

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncRoute = (handler: AsyncRoute) => (req: Request, res: Response, next: NextFunction): void => {
  void handler(req, res, next).catch(next);
};

ensureDocxStorage();
router.use(authMiddleware);
router.use(compressionControlLimiter);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/config', (_req, res) => {
  res.json({ success: true, data: {
    enabled: config.docx.enabled,
    clientMaxBytes: config.docx.clientMaxBytes,
    maxUploadBytes: config.docx.maxUploadBytes,
    nativeMaxPages: config.docx.nativeMaxPages,
    ocrMaxPages: config.docx.ocrMaxPages,
    visualMaxPages: config.docx.visualMaxPages,
    uploadChunkBytes: config.docx.uploadChunkBytes,
  }});
});

router.post('/upload-slots', asyncRoute(async (req, res) => {
  if (!config.docx.enabled) {
    res.status(503).json({ success: false, error: 'Server DOCX conversion is unavailable', code: 'DOCX_UNAVAILABLE' });
    return;
  }
  const parsed = createSlotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid DOCX upload request' });
    return;
  }
  const { mode, inputBytes } = parsed.data as { mode: DocxMode; inputBytes: number };
  if (inputBytes > config.docx.maxUploadBytes) {
    res.status(413).json({ success: false, error: 'Maximum DOCX conversion upload is 50 MB', code: 'DOCX_FILE_TOO_LARGE' });
    return;
  }
  try {
    const slot = await reserveDocxUploadSlot(req.user!.id, mode, inputBytes);
    res.status(201).json({ success: true, data: { slot } });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTIVE_UPLOAD_EXISTS') {
      res.status(409).json({ success: false, error: 'Finish or cancel your existing DOCX conversion upload first', code: 'ACTIVE_UPLOAD_EXISTS' });
      return;
    }
    throw error;
  }
}));

router.get('/upload-slots/:id', asyncRoute(async (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid upload slot id' }); return; }
  const slot = await getDocxUploadSlot(parsed.data, req.user!.id);
  if (!slot) { res.status(404).json({ success: false, error: 'Upload reservation expired' }); return; }
  res.json({ success: true, data: { slot } });
}));

router.delete('/upload-slots/:id', asyncRoute(async (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid upload slot id' }); return; }
  await releaseDocxUploadSlot(parsed.data, req.user!.id);
  res.status(204).end();
}));

router.get('/jobs/:id', asyncRoute(async (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid job id' }); return; }
  const job = await getDocxJobForUser(parsed.data, req.user!.id);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  if (job.expiresAt.getTime() <= Date.now()) {
    await deleteCompletedDocxJob(job.id, req.user!.id);
    res.status(410).json({ success: false, error: 'Job result has expired' });
    return;
  }
  res.json({ success: true, data: { job, queuePosition: await getDocxQueuePosition(job) } });
}));

router.delete('/jobs/:id', asyncRoute(async (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid job id' }); return; }
  const job = await requestDocxCancellation(parsed.data, req.user!.id);
  if (!job) { res.status(404).json({ success: false, error: 'Active job not found' }); return; }
  if (job.status === 'cancelled' && !job.startedAt) {
    await Promise.all([rm(getDocxJobInputPath(job.id), { force: true }), rm(getDocxJobOutputPath(job.id), { force: true })]);
  }
  res.json({ success: true, data: { job } });
}));

router.get('/jobs/:id/download', asyncRoute(async (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid job id' }); return; }
  const job = await getDocxJobForUser(parsed.data, req.user!.id);
  if (!job || job.status !== 'completed') { res.status(404).json({ success: false, error: 'Completed job not found' }); return; }
  if (job.expiresAt.getTime() <= Date.now()) {
    await deleteCompletedDocxJob(job.id, req.user!.id);
    res.status(410).json({ success: false, error: 'Job result has expired' });
    return;
  }
  res.download(getDocxJobOutputPath(job.id), 'igo-converted.docx', async (error) => {
    if (!error) await deleteCompletedDocxJob(job.id, req.user!.id);
  });
}));

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('DOCX route failed', { reason: error instanceof Error ? error.message : 'UNKNOWN' });
  res.status(500).json({ success: false, error: 'DOCX conversion service error' });
});

export default router;
