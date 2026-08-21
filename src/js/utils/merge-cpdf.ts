import { WasmProvider } from './wasm-provider';
import { MERGE_WORKER_URL } from './merge-worker-url.js';
import { wfError } from '../workflow/errors';

export interface MergeFile {
  name: string;
  data: ArrayBuffer;
}

export async function mergePdfsCpdf(
  files: MergeFile[],
  options?: { retainPageLabels?: boolean }
): Promise<Uint8Array> {
  if (files.length === 0) {
    throw new Error(wfError('noPdfsConnected', { node: 'Merge' }));
  }

  const cpdfBaseUrl = WasmProvider.getUrl('cpdf');
  if (!cpdfBaseUrl) {
    throw new Error(wfError('cpdfNotConfigured'));
  }

  const jobs = files.map((f) => ({
    fileName: f.name,
    rangeType: 'all' as const,
  }));

  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(MERGE_WORKER_URL);

    worker.onmessage = (e: MessageEvent) => {
      // The shared merge worker reports progress while it is parsing and
      // combining files. Keep the workflow promise alive until a terminal
      // success/error response arrives.
      if (e.data?.status === 'progress') return;

      worker.terminate();
      if (e.data.status === 'success') {
        resolve(new Uint8Array(e.data.pdfBytes));
      } else {
        reject(
          new Error(
            e.data.message || wfError('workerError', { message: 'unknown' })
          )
        );
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      const details = [
        err.message,
        err.filename ? `file: ${err.filename}` : '',
        err.lineno ? `line: ${err.lineno}` : '',
      ]
        .filter(Boolean)
        .join(' — ');
      console.error('[Workflow merge] Worker failed to start or crashed', {
        url: MERGE_WORKER_URL,
        details: details || 'no browser error details',
      });
      reject(
        new Error(
          wfError('workerError', { message: details || 'unknown' })
        )
      );
    };

    worker.postMessage(
      {
        command: 'merge',
        files,
        jobs,
        cpdfUrl: cpdfBaseUrl + 'coherentpdf.browser.min.js',
        retainPageLabels: options?.retainPageLabels === true,
      },
      // Keep workflow inputs reusable if the worker reports an error.
      files.map((f) => f.data.slice(0))
    );
  });
}
