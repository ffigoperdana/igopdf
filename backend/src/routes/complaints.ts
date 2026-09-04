import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  ComplaintServiceError,
  complaintPublicConfig,
  createComplaintDraft,
  createComplaintUploadSlot,
  getComplaintAttachmentForOwner,
  getComplaintUploadSlot,
  getMainComplaintFeature,
  releaseComplaintUploadSlot,
  submitComplaint,
} from '../services/complaintService.js';
import { FileValidationError } from '../utils/fileValidation.js';
import { sanitizeRichText } from '../utils/richText.js';
import { logger } from '../utils/logger.js';
import { sendComplaintSubmittedEmail } from '../services/emailService.js';

const router = Router();
const idSchema = z.string().uuid();
const complaintSchema = z
  .object({
    category: z.enum(['main_feature', 'other_feature', 'non_feature']),
    featureId: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .nullable()
      .optional(),
    featureName: z.string().trim().min(2).max(180).nullable().optional(),
    subject: z.string().trim().min(5).max(180),
    contentHtml: z.string().min(1).max(50_000),
  })
  .superRefine((data, context) => {
    if (data.category === 'main_feature' && !getMainComplaintFeature(data.featureId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['featureId'],
        message: 'Pilih fitur utama yang tersedia',
      });
    }
    if (data.category === 'other_feature' && !data.featureId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['featureId'],
        message: 'Pilih fitur IGO yang terkait',
      });
    }
  });

const createSlotSchema = z.object({
  filename: z.string().min(1).max(512),
  inputBytes: z.number().int().positive().safe(),
});

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;
const asyncRoute = (handler: AsyncRoute) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };

function validId(
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
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/config', (_req, res) => {
  res.json({ success: true, data: complaintPublicConfig() });
});

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = complaintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Data aduan tidak valid',
        details: parsed.error.issues,
      });
      return;
    }
    const content = sanitizeRichText(parsed.data.contentHtml);
    if (content.characterCount < 250) {
      res.status(400).json({
        success: false,
        error: 'Isi aduan minimal 250 karakter',
        code: 'COMPLAINT_CONTENT_TOO_SHORT',
      });
      return;
    }
    const mainFeature = getMainComplaintFeature(parsed.data.featureId);
    const ticket = await createComplaintDraft({
      reporterId: req.user!.id,
      reporterUsername: req.user!.username,
      category: parsed.data.category,
      featureId:
        parsed.data.category === 'non_feature'
          ? null
          : (parsed.data.featureId ?? null),
      featureName:
        parsed.data.category === 'main_feature'
          ? (mainFeature?.name ?? null)
          : parsed.data.category === 'other_feature'
            ? (parsed.data.featureName ?? parsed.data.featureId ?? null)
            : null,
      subject: parsed.data.subject,
      contentHtml: content.html,
      contentText: content.text,
    });
    res.status(201).json({ success: true, data: { ticket } });
  })
);

router.post(
  '/:ticketId/upload-slots',
  asyncRoute(async (req, res) => {
    const ticketId = validId(req.params.ticketId, 'ID tiket', res);
    if (!ticketId) return;
    const parsed = createSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Data file tidak valid' });
      return;
    }
    const slot = await createComplaintUploadSlot(
      ticketId,
      req.user!.id,
      parsed.data.filename,
      parsed.data.inputBytes
    );
    res.status(201).json({ success: true, data: { slot } });
  })
);

router.get(
  '/:ticketId/upload-slots/:slotId',
  asyncRoute(async (req, res) => {
    const ticketId = validId(req.params.ticketId, 'ID tiket', res);
    const slotId = validId(req.params.slotId, 'ID upload', res);
    if (!ticketId || !slotId) return;
    const slot = await getComplaintUploadSlot(slotId, req.user!.id);
    if (!slot || slot.ticketId !== ticketId) {
      res.status(404).json({ success: false, error: 'Slot upload tidak ditemukan' });
      return;
    }
    res.json({ success: true, data: { slot } });
  })
);

router.delete(
  '/:ticketId/upload-slots/:slotId',
  asyncRoute(async (req, res) => {
    const ticketId = validId(req.params.ticketId, 'ID tiket', res);
    const slotId = validId(req.params.slotId, 'ID upload', res);
    if (!ticketId || !slotId) return;
    const slot = await getComplaintUploadSlot(slotId, req.user!.id);
    if (!slot || slot.ticketId !== ticketId) {
      res.status(404).json({ success: false, error: 'Slot upload tidak ditemukan' });
      return;
    }
    await releaseComplaintUploadSlot(slotId, req.user!.id);
    res.status(204).end();
  })
);

router.post(
  '/:ticketId/submit',
  asyncRoute(async (req, res) => {
    const ticketId = validId(req.params.ticketId, 'ID tiket', res);
    if (!ticketId) return;
    const ticket = await submitComplaint(ticketId, req.user!.id);
    const notification = await sendComplaintSubmittedEmail(ticket);
    res.json({ success: true, data: { ticket, notification } });
  })
);

router.get(
  '/:ticketId/attachments/:attachmentId/download',
  asyncRoute(async (req, res, next) => {
    const ticketId = validId(req.params.ticketId, 'ID tiket', res);
    const attachmentId = validId(req.params.attachmentId, 'ID lampiran', res);
    if (!ticketId || !attachmentId) return;
    const attachment = await getComplaintAttachmentForOwner(
      ticketId,
      attachmentId,
      req.user!.id
    );
    if (!attachment) {
      res.status(404).json({
        success: false,
        error: 'Lampiran tidak ditemukan atau masa simpan sudah habis',
      });
      return;
    }
    res.set({
      'Content-Type': attachment.mimeType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.download(attachment.storagePath, attachment.originalFilename, (error) => {
      if (error) next(error);
    });
  })
);

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ComplaintServiceError || error instanceof FileValidationError) {
    res.status(error instanceof ComplaintServiceError ? error.statusCode : 415).json({
      success: false,
      error: error.message,
      code: error instanceof ComplaintServiceError ? error.code : 'INVALID_FILE',
    });
    return;
  }
  logger.error('Complaint route failed', {
    reason: error instanceof Error ? error.message : 'UNKNOWN',
  });
  res.status(500).json({ success: false, error: 'Layanan aduan sedang bermasalah' });
});

export default router;
