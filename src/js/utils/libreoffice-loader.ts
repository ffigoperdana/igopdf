/**
 * LibreOffice WASM Converter Wrapper
 *
 * Uses @matbee/libreoffice-converter package for document conversion.
 * Handles progress tracking and provides simpler API.
 */

import { WorkerBrowserConverter } from '@matbee/libreoffice-converter/browser';
import type { InputFormat } from '@matbee/libreoffice-converter/browser';

const LIBREOFFICE_LOCAL_PATH = import.meta.env.BASE_URL + 'libreoffice-wasm/';

export interface LoadProgress {
  phase: 'loading' | 'initializing' | 'converting' | 'complete' | 'ready';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: LoadProgress) => void;

export type LibreOfficeErrorCode =
  | 'BROWSER_ISOLATION_REQUIRED'
  | 'CONVERSION_ENGINE_TIMEOUT';

export class LibreOfficeError extends Error {
  readonly code: LibreOfficeErrorCode;

  constructor(code: LibreOfficeErrorCode, message: string) {
    super(message);
    this.name = 'LibreOfficeError';
    this.code = code;
  }
}

const CONVERSION_ENGINE_TIMEOUT_MS = 120_000;

function assertBrowserCapabilities(): void {
  // The converter is a browser-only feature. Keeping this guard out of
  // non-browser environments also makes the wrapper safe to import in tests
  // and during the Vite build.
  if (typeof window === 'undefined') return;

  const runtime = globalThis as typeof globalThis & {
    crossOriginIsolated?: boolean;
    isSecureContext?: boolean;
  };

  if (
    runtime.isSecureContext !== true ||
    runtime.crossOriginIsolated !== true ||
    typeof SharedArrayBuffer === 'undefined'
  ) {
    throw new LibreOfficeError(
      'BROWSER_ISOLATION_REQUIRED',
      'The conversion engine requires a secure, cross-origin-isolated page.'
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new LibreOfficeError(
          'CONVERSION_ENGINE_TIMEOUT',
          'The conversion engine took too long to initialize.'
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// Singleton for converter instance
let converterInstance: LibreOfficeConverter | null = null;

export class LibreOfficeConverter {
  private converter: WorkerBrowserConverter | null = null;
  private initialized = false;
  private initializing = false;
  private initializationPromise: Promise<void> | null = null;
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || LIBREOFFICE_LOCAL_PATH;
  }

  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.initialized) return;

    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.initializeInternal(onProgress).finally(
      () => {
        this.initializationPromise = null;
        this.initializing = false;
      }
    );

    return this.initializationPromise;
  }

  private async initializeInternal(
    onProgress?: ProgressCallback
  ): Promise<void> {
    assertBrowserCapabilities();

    this.initializing = true;
    let progressCallback = onProgress;

    progressCallback?.({
      phase: 'loading',
      percent: 0,
      message: 'Loading conversion engine...',
    });

    const converter = new WorkerBrowserConverter({
      sofficeJs: `${this.basePath}soffice.js`,
      sofficeWasm: `${this.basePath}soffice.wasm.gz`,
      sofficeData: `${this.basePath}soffice.data.gz`,
      sofficeWorkerJs: `${this.basePath}soffice.worker.js`,
      browserWorkerJs: `${this.basePath}browser.worker.global.js`,
      verbose: false,
      onProgress: (info: {
        phase: string;
        percent: number;
        message: string;
      }) => {
        if (progressCallback && !this.initialized) {
          const simplifiedMessage = `Loading conversion engine (${Math.round(info.percent)}%)...`;
          progressCallback({
            phase: info.phase as LoadProgress['phase'],
            percent: info.percent,
            message: simplifiedMessage,
          });
        }
      },
      onReady: () => {
        console.log('[LibreOffice] Ready!');
      },
      onError: (error: Error) => {
        console.error('[LibreOffice] Error:', error);
      },
    });

    this.converter = converter;

    try {
      await withTimeout(
        converter.initialize(),
        CONVERSION_ENGINE_TIMEOUT_MS
      );
      this.initialized = true;

      progressCallback?.({
        phase: 'ready',
        percent: 100,
        message: 'Conversion engine ready!',
      });
    } catch (error) {
      this.initialized = false;
      this.converter = null;

      try {
        await converter.destroy();
      } catch (destroyError) {
        console.warn(
          '[LibreOffice] Cleanup after initialization failure failed:',
          destroyError
        );
      }

      throw error;
    } finally {
      // Prevent late worker progress events from updating a finished loader.
      progressCallback = undefined;
    }
  }

  isReady(): boolean {
    return this.initialized && this.converter !== null;
  }

  async convertToPdf(file: File): Promise<Blob> {
    if (!this.converter) {
      throw new Error('Converter not initialized');
    }

    console.log(`[LibreOffice] Converting ${file.name} to PDF...`);
    console.log(
      `[LibreOffice] File type: ${file.type}, Size: ${file.size} bytes`
    );

    try {
      console.log(`[LibreOffice] Reading file as ArrayBuffer...`);
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      console.log(`[LibreOffice] File loaded, ${uint8Array.length} bytes`);

      console.log(`[LibreOffice] Calling converter.convert() with buffer...`);
      const startTime = Date.now();

      // Detect input format - critical for CSV to apply import filters
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      console.log(`[LibreOffice] Detected format from extension: ${ext}`);

      const result = await this.converter.convert(
        uint8Array,
        {
          outputFormat: 'pdf',
          inputFormat: ext as InputFormat,
        },
        file.name
      );

      const duration = Date.now() - startTime;
      console.log(
        `[LibreOffice] Conversion complete! Duration: ${duration}ms, Size: ${result.data.length} bytes`
      );

      // Create a copy to avoid SharedArrayBuffer type issues
      const data = new Uint8Array(result.data);
      return new Blob([data], { type: result.mimeType });
    } catch (error) {
      console.error(`[LibreOffice] Conversion FAILED for ${file.name}:`, error);
      console.error(`[LibreOffice] Error details:`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  async wordToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async pptToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async excelToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async destroy(): Promise<void> {
    if (this.converter) {
      await this.converter.destroy();
    }
    this.converter = null;
    this.initialized = false;
  }
}

export function getLibreOfficeConverter(
  basePath?: string
): LibreOfficeConverter {
  if (!converterInstance) {
    converterInstance = new LibreOfficeConverter(basePath);
  }
  return converterInstance;
}
