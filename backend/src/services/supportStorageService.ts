import { mkdir, statfs } from 'node:fs/promises';
import { config } from '../config/index.js';
import { pool } from '../config/database.js';
import { getMalwareScannerStatus } from './malwareScanService.js';

export interface SupportStorageStatus {
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    availablePercent: number;
    minimumFreeBytes: number;
    state: 'ok' | 'warning' | 'critical';
  };
  trackedFiles: {
    guideBytes: number;
    guideFiles: number;
    complaintBytes: number;
    complaintFiles: number;
  };
  malwareScan: {
    enabled: boolean;
    required: boolean;
    available: boolean | null;
    maxBytes: number;
  };
  updatedAt: string;
}

function toSafeNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function getSupportStorageStatus(): Promise<SupportStorageStatus> {
  // The volume may not be materialized until the first upload on a new
  // deployment. Creating only the top-level private directory is safe and
  // makes the Report view usable before the first Guide/Aduan asset exists.
  await mkdir(config.support.storageDir, { recursive: true, mode: 0o700 });

  const [filesystem, totals, malwareScan] = await Promise.all([
    statfs(config.support.storageDir),
    pool.query<{
      guideBytes: string;
      guideFiles: string;
      complaintBytes: string;
      complaintFiles: string;
    }>(
      `SELECT
         COALESCE((
           SELECT SUM(size_bytes) FROM guide_materials
           WHERE asset_status = 'ready' AND storage_key IS NOT NULL
         ), 0)::text AS "guideBytes",
         (SELECT COUNT(*) FROM guide_materials
           WHERE asset_status = 'ready' AND storage_key IS NOT NULL)::text AS "guideFiles",
         COALESCE((
           SELECT SUM(size_bytes) FROM complaint_attachments
           WHERE purged_at IS NULL AND expires_at > NOW()
         ), 0)::text AS "complaintBytes",
         (SELECT COUNT(*) FROM complaint_attachments
           WHERE purged_at IS NULL AND expires_at > NOW())::text AS "complaintFiles"`
    ),
    getMalwareScannerStatus(),
  ]);

  const blockSize = Number(filesystem.bsize);
  const totalBytes = Number(filesystem.blocks) * blockSize;
  const availableBytes = Number(filesystem.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const availablePercent =
    totalBytes > 0 ? Number(((availableBytes / totalBytes) * 100).toFixed(1)) : 0;
  const state =
    availableBytes <= config.support.diskMinimumFreeBytes
      ? 'critical'
      : availablePercent <= 15
        ? 'warning'
        : 'ok';
  const row = totals.rows[0] ?? {
    guideBytes: '0',
    guideFiles: '0',
    complaintBytes: '0',
    complaintFiles: '0',
  };

  return {
    disk: {
      totalBytes,
      usedBytes,
      availableBytes,
      availablePercent,
      minimumFreeBytes: config.support.diskMinimumFreeBytes,
      state,
    },
    trackedFiles: {
      guideBytes: toSafeNonNegativeNumber(row.guideBytes),
      guideFiles: toSafeNonNegativeNumber(row.guideFiles),
      complaintBytes: toSafeNonNegativeNumber(row.complaintBytes),
      complaintFiles: toSafeNonNegativeNumber(row.complaintFiles),
    },
    malwareScan: {
      ...malwareScan,
      maxBytes: config.malwareScan.maxBytes,
    },
    updatedAt: new Date().toISOString(),
  };
}
