import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  ComplaintServiceError,
  changeComplaintStatus,
  getAdminComplaint,
  getComplaintAttachmentForAdmin,
  listAdminComplaints,
  resolveComplaint,
  type ComplaintStatus,
} from '../services/complaintService.js';
import { sanitizeRichText } from '../utils/richText.js';
import { logger } from '../utils/logger.js';
import { sendComplaintResolvedEmail } from '../services/emailService.js';

const router = Router();
const idSchema = z.string().uuid();
const statusSchema = z.object({ status: z.enum(['open', 'in_progress']) });
const resolveSchema = z.object({ contentHtml: z.string().min(1).max(50_000) });

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
  name: string,
  res: Response
): string | null {
  const parsed = idSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  res.status(400).json({ success: false, error: `${name} tidak valid` });
  return null;
}

function readPage(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

router.use(authMiddleware);
router.use(requireAdmin);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status =
      rawStatus === 'open' || rawStatus === 'in_progress' || rawStatus === 'resolved'
        ? (rawStatus as ComplaintStatus)
        : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 180) : undefined;
    const page = readPage(req.query.page, 1, 10_000);
    const limit = readPage(req.query.limit, 25, 100);
    const result = await listAdminComplaints({ status, search, page, limit });
    res.json({
      success: true,
      data: result.tickets,
      total: result.total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(result.total / limit)),
    });
  })
);

router.get(
  '/:ticketId',
  asyncRoute(async (req, res) => {
    const ticketId = readId(req.params.ticketId, 'ID tiket', res);
    if (!ticketId) return;
    const ticket = await getAdminComplaint(ticketId);
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
      return;
    }
    res.json({ success: true, data: { ticket } });
  })
);

router.patch(
  '/:ticketId/status',
  asyncRoute(async (req, res) => {
    const ticketId = readId(req.params.ticketId, 'ID tiket', res);
    if (!ticketId) return;
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Status tidak valid' });
      return;
    }
    const ticket = await changeComplaintStatus(
      ticketId,
      parsed.data.status,
      req.user!.id
    );
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
      return;
    }
    res.json({ success: true, data: { ticket } });
  })
);

router.post(
  '/:ticketId/resolve',
  asyncRoute(async (req, res) => {
    const ticketId = readId(req.params.ticketId, 'ID tiket', res);
    if (!ticketId) return;
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Catatan penyelesaian tidak valid' });
      return;
    }
    const note = sanitizeRichText(parsed.data.contentHtml);
    if (note.characterCount < 250) {
      res.status(400).json({
        success: false,
        error: 'Catatan penyelesaian minimal 250 karakter',
        code: 'RESOLUTION_TOO_SHORT',
      });
      return;
    }
    const ticket = await resolveComplaint(
      ticketId,
      req.user!.id,
      note.html,
      note.text
    );
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Tiket tidak ditemukan' });
      return;
    }
    const notification = await sendComplaintResolvedEmail(ticket);
    res.json({ success: true, data: { ticket, notification } });
  })
);

router.get(
  '/:ticketId/attachments/:attachmentId/download',
  asyncRoute(async (req, res, next) => {
    const ticketId = readId(req.params.ticketId, 'ID tiket', res);
    const attachmentId = readId(req.params.attachmentId, 'ID lampiran', res);
    if (!ticketId || !attachmentId) return;
    const attachment = await getComplaintAttachmentForAdmin(ticketId, attachmentId);
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
  if (error instanceof ComplaintServiceError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }
  logger.error('Admin complaint route failed', {
    reason: error instanceof Error ? error.message : 'UNKNOWN',
  });
  res.status(500).json({ success: false, error: 'Layanan aduan sedang bermasalah' });
});

export default router;
