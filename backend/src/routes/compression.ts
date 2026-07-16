import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createJobFromUpload,
  deleteCompletedJob,
  getJobForUser,
  getJobInputPath,
  getJobOutputPath,
  getQueuePosition,
  requestJobCancellation,
  ensureCompressionStorage,
} from '../services/compressionJobService.js';
import { logger } from '../utils/logger.js';

const router = Router();

const jobIdSchema = z.string().uuid();
const createJobSchema = z.object({
  mode: z.enum(['lossless', 'balanced']),
});

ensureCompressionStorage();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) =>
      callback(null, path.join(config.compression.jobsDir, 'incoming')),
    filename: (_req, _file, callback) => callback(null, `${randomUUID()}.pdf`),
  }),
  limits: {
    files: 1,
    fileSize: config.compression.maxUploadBytes,
    fields: 4,
  },
  fileFilter: (_req, file, callback) => {
    const looksLikePdf =
      file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    if (looksLikePdf) callback(null, true);
    else callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
  },
});

async function isPdfFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 5 && header.toString('ascii') === '%PDF-';
  } finally {
    await handle.close();
  }
}

router.use(authMiddleware);

router.get('/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      enabled: config.compression.enabled,
      clientThresholdBytes: config.compression.clientThresholdBytes,
      balancedMaxBytes: config.compression.balancedMaxBytes,
      maxUploadBytes: config.compression.maxUploadBytes,
    },
  });
});

router.post('/jobs', (req, res, next) => {
  if (!config.compression.enabled) {
    res.status(503).json({ success: false, error: 'Server-side compression is unavailable' });
    return;
  }
  upload.single('file')(req, res, next);
}, async (req, res) => {
  const uploadedFile = req.file;
  let uploadPath: string | null = uploadedFile?.path || null;

  try {
    if (!uploadedFile || !uploadPath) {
      res.status(400).json({ success: false, error: 'A PDF file is required' });
      return;
    }

    const validation = createJobSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({ success: false, error: 'Invalid compression mode' });
      return;
    }
    if (uploadedFile.size <= config.compression.clientThresholdBytes) {
      res.status(400).json({ success: false, error: 'This file should be compressed in the browser' });
      return;
    }
    if (
      validation.data.mode === 'balanced' &&
      uploadedFile.size > config.compression.balancedMaxBytes
    ) {
      res.status(400).json({ success: false, error: 'Balanced compression is limited to 500 MB' });
      return;
    }
    if (!(await isPdfFile(uploadPath))) {
      res.status(400).json({ success: false, error: 'The uploaded file is not a valid PDF' });
      return;
    }

    const job = await createJobFromUpload(req.user!.id, validation.data.mode, uploadPath);
    uploadPath = null;
    const queuePosition = await getQueuePosition(job);
    res.status(202).json({ success: true, data: { job, queuePosition } });
  } catch (error) {
    logger.error('Compression job upload failed');
    res.status(500).json({ success: false, error: 'Could not create compression job' });
  } finally {
    if (uploadPath) await rm(uploadPath, { force: true });
  }
});

router.get('/jobs/:id', async (req, res) => {
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
  res.json({ success: true, data: { job, queuePosition: await getQueuePosition(job) } });
});

router.delete('/jobs/:id', async (req, res) => {
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
});

router.get('/jobs/:id/download', async (req, res) => {
  const parsed = jobIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid job id' });
    return;
  }
  const job = await getJobForUser(parsed.data, req.user!.id);
  if (!job || job.status !== 'completed') {
    res.status(404).json({ success: false, error: 'Completed job not found' });
    return;
  }
  if (job.expiresAt.getTime() <= Date.now()) {
    await deleteCompletedJob(job.id, req.user!.id);
    res.status(410).json({ success: false, error: 'Job result has expired' });
    return;
  }

  res.download(getJobOutputPath(job.id), 'igo-compressed.pdf', async (error) => {
    if (!error) await deleteCompletedJob(job.id, req.user!.id);
  });
});

router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (req.file?.path) void rm(req.file.path, { force: true });
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Maximum upload size is 1 GB'
      : 'Invalid upload';
    res.status(400).json({ success: false, error: message });
    return;
  }
  logger.error('Compression upload rejected');
  res.status(400).json({ success: false, error: 'Invalid upload' });
});

export default router;
