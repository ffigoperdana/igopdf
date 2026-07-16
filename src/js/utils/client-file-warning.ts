import { t } from '../i18n/i18n.js';
import { showAlert } from '../ui.js';
import { formatBytes } from './helpers.js';

export const CLIENT_SIDE_LARGE_FILE_BYTES = 150 * 1024 * 1024;
export const CLIENT_SIDE_OCR_WARNING_BYTES = 50 * 1024 * 1024;

export function totalFileBytes(files: readonly File[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/**
 * Client-side tools remain available for large documents. This warning keeps
 * the choice with the user while explaining that the browser does the work.
 */
export function warnForLargeClientSideFiles(
  files: readonly File[],
  tool: string,
  threshold = CLIENT_SIDE_LARGE_FILE_BYTES
): boolean {
  const totalBytes = totalFileBytes(files);
  if (totalBytes <= threshold) return false;

  showAlert(
    t('clientProcessing.largeFileTitle'),
    t('clientProcessing.largeFileMessage', {
      tool,
      size: formatBytes(totalBytes),
    }),
    'warning'
  );
  return true;
}
