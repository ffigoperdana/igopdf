import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  GuideServiceError,
  createGuideMaterial,
  createGuideUploadSlot,
  deleteGuideMaterial,
  getGuideAsset,
  getGuideUploadSlot,
  listGuideMaterialsForAdmin,
  releaseGuideUploadSlot,
  reorderGuideMaterials,
  updateGuideMaterial,
} from '../services/guideService.js';
import { streamInlineMedia } from '../utils/fileStreaming.js';
import { logger } from '../utils/logger.js';

const router = Router();
const idSchema = z.string().uuid();
const createGuideSchema = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(2_000).default(''),
  assetType: z.enum(['pdf', 'video']),
});
const updateGuideSchema = z
  .object({
    title: z.string().trim().min(3).max(180).optional(),
    description: z.string().trim().max(2_000).optional(),
    isPublished: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Tidak ada perubahan materi',
  });
const uploadSlotSchema = z.object({
  filename: z.string().min(1).max(512),
  inputBytes: z.number().int().positive().safe(),
});
const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(500) });

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;
const asyncRoute = (handler: AsyncRoute) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };

function readId(
  value: string | string[],
  label: string,
  res: Response
): string | null {
  const parsed = idSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  res.status(400).json({ success: false, error: `${label} tidak valid` });
  return null;
}

router.use(authMiddleware);
router.use(requireAdmin);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const guides = await listGuideMaterialsForAdmin();
    res.json({ success: true, data: { guides } });
  })
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = createGuideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Data materi tidak valid',
        details: parsed.error.issues,
      });
      return;
    }
    const guide = await createGuideMaterial({ ...parsed.data, adminId: req.user!.id });
    res.status(201).json({ success: true, data: { guide } });
  })
);

router.put(
  '/reorder',
  asyncRoute(async (req, res) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Urutan materi tidak valid' });
      return;
    }
    await reorderGuideMaterials(parsed.data.ids);
    res.status(204).end();
  })
);

router.patch(
  '/:guideId',
  asyncRoute(async (req, res) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    if (!guideId) return;
    const parsed = updateGuideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Perubahan materi tidak valid',
        details: parsed.error.issues,
      });
      return;
    }
    const guide = await updateGuideMaterial(guideId, parsed.data, req.user!.id);
    if (!guide) {
      res.status(404).json({ success: false, error: 'Materi tidak ditemukan' });
      return;
    }
    res.json({ success: true, data: { guide } });
  })
);

router.delete(
  '/:guideId',
  asyncRoute(async (req, res) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    if (!guideId) return;
    const deleted = await deleteGuideMaterial(guideId);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Materi tidak ditemukan' });
      return;
    }
    res.status(204).end();
  })
);

router.post(
  '/:guideId/upload-slots',
  asyncRoute(async (req, res) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    if (!guideId) return;
    const parsed = uploadSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Data file tidak valid' });
      return;
    }
    const slot = await createGuideUploadSlot(
      guideId,
      req.user!.id,
      parsed.data.filename,
      parsed.data.inputBytes
    );
    res.status(201).json({ success: true, data: { slot } });
  })
);

router.get(
  '/:guideId/upload-slots/:slotId',
  asyncRoute(async (req, res) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    const slotId = readId(req.params.slotId, 'ID upload', res);
    if (!guideId || !slotId) return;
    const slot = await getGuideUploadSlot(slotId, req.user!.id);
    if (!slot || slot.guideId !== guideId) {
      res.status(404).json({ success: false, error: 'Slot upload tidak ditemukan' });
      return;
    }
    res.json({ success: true, data: { slot } });
  })
);

router.delete(
  '/:guideId/upload-slots/:slotId',
  asyncRoute(async (req, res) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    const slotId = readId(req.params.slotId, 'ID upload', res);
    if (!guideId || !slotId) return;
    const slot = await getGuideUploadSlot(slotId, req.user!.id);
    if (!slot || slot.guideId !== guideId) {
      res.status(404).json({ success: false, error: 'Slot upload tidak ditemukan' });
      return;
    }
    await releaseGuideUploadSlot(slotId, req.user!.id);
    res.status(204).end();
  })
);

router.get(
  '/:guideId/file',
  asyncRoute(async (req, res, next) => {
    const guideId = readId(req.params.guideId, 'ID materi', res);
    if (!guideId) return;
    const guide = await getGuideAsset(guideId, false);
    if (!guide) {
      res.status(404).json({ success: false, error: 'File materi tidak ditemukan' });
      return;
    }
    await streamInlineMedia(req, res, next, {
      path: guide.storagePath,
      filename: guide.originalFilename || `guide.${guide.assetType === 'pdf' ? 'pdf' : 'mp4'}`,
      mimeType: guide.mimeType || (guide.assetType === 'pdf' ? 'application/pdf' : 'video/mp4'),
    });
  })
);

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof GuideServiceError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }
  logger.error('Admin Guide route failed', {
    reason: error instanceof Error ? error.message : 'UNKNOWN',
  });
  res.status(500).json({ success: false, error: 'Layanan Guide sedang bermasalah' });
});

export default router;
