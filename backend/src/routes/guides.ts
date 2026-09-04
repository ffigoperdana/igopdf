import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  getGuideAsset,
  guidePublicConfig,
  listPublishedGuideMaterials,
} from '../services/guideService.js';
import { streamInlineMedia } from '../utils/fileStreaming.js';
import {
  guideAssetExtension,
  guideAssetMimeType,
} from '../utils/fileValidation.js';
import { logger } from '../utils/logger.js';

const router = Router();
const idSchema = z.string().uuid();

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

router.use(authMiddleware);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/config', (_req, res) => {
  res.json({ success: true, data: guidePublicConfig() });
});

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const guides = await listPublishedGuideMaterials();
    res.json({ success: true, data: { guides } });
  })
);

router.get(
  '/:guideId/file',
  asyncRoute(async (req, res, next) => {
    const parsed = idSchema.safeParse(req.params.guideId);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'ID materi tidak valid' });
      return;
    }
    const guide = await getGuideAsset(parsed.data, true);
    if (!guide) {
      res.status(404).json({ success: false, error: 'Materi tidak ditemukan' });
      return;
    }
    await streamInlineMedia(req, res, next, {
      path: guide.storagePath,
      filename:
        guide.originalFilename ||
        `guide.${guideAssetExtension(guide.assetType)}`,
      mimeType: guide.mimeType || guideAssetMimeType(guide.assetType),
    });
  })
);

router.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Guide route failed', {
      reason: error instanceof Error ? error.message : 'UNKNOWN',
    });
    res
      .status(500)
      .json({ success: false, error: 'Layanan Guide sedang bermasalah' });
  }
);

export default router;
