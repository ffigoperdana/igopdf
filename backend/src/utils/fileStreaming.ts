import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';

function inlineDisposition(filename: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function streamInlineMedia(
  req: Request,
  res: Response,
  next: NextFunction,
  input: {
    path: string;
    filename: string;
    mimeType: string;
  }
): Promise<void> {
  try {
    const file = await stat(input.path);
    const total = file.size;
    const commonHeaders = {
      'Content-Type': input.mimeType,
      'Content-Disposition': inlineDisposition(input.filename),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    };
    const range = req.headers.range;
    if (!range) {
      res.status(200).set({ ...commonHeaders, 'Content-Length': String(total) });
      const stream = createReadStream(input.path);
      stream.on('error', next);
      stream.pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    const requestedStart = match[1] ? Number(match[1]) : null;
    const requestedEnd = match[2] ? Number(match[2]) : null;
    const start = requestedStart === null
      ? Math.max(total - (requestedEnd ?? 0), 0)
      : requestedStart;
    const end = requestedEnd === null ? total - 1 : requestedEnd;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= total
    ) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    const boundedEnd = Math.min(end, total - 1);
    res.status(206).set({
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${boundedEnd}/${total}`,
      'Content-Length': String(boundedEnd - start + 1),
    });
    const stream = createReadStream(input.path, { start, end: boundedEnd });
    stream.on('error', next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
}
