import { PDFDocument } from 'pdf-lib';
import { getPDFDocument } from './helpers.js';
import { loadPyMuPDF } from './pymupdf-loader.js';

export const CONDENSE_PRESETS = {
  light: {
    images: { quality: 90, dpiTarget: 150, dpiThreshold: 200 },
    scrub: { metadata: false, thumbnails: true },
    subsetFonts: true,
  },
  balanced: {
    images: { quality: 75, dpiTarget: 96, dpiThreshold: 150 },
    scrub: { metadata: true, thumbnails: true },
    subsetFonts: true,
  },
  aggressive: {
    images: { quality: 50, dpiTarget: 72, dpiThreshold: 100 },
    scrub: { metadata: true, thumbnails: true, xmlMetadata: true },
    subsetFonts: true,
  },
  extreme: {
    images: { quality: 30, dpiTarget: 60, dpiThreshold: 96 },
    scrub: { metadata: true, thumbnails: true, xmlMetadata: true },
    subsetFonts: true,
  },
};

export const PHOTON_PRESETS = {
  light: { scale: 2.0, quality: 0.85 },
  balanced: { scale: 1.5, quality: 0.65 },
  aggressive: { scale: 1.2, quality: 0.45 },
  extreme: { scale: 1.0, quality: 0.25 },
};

// Keep a single rendered page within a predictable browser memory budget. A
// few scanned PDFs contain unusually large page boxes; rendering those at the
// normal Photon scale can exceed a browser's canvas limit even when the PDF
// itself is small. The output page keeps its original dimensions, while only
// the temporary raster is scaled down when necessary.
const PHOTON_MAX_RENDER_PIXELS = 24_000_000;

export type PhotonProgressStage =
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'embedding'
  | 'finalizing';

export type PhotonProgressCallback = (
  currentPage: number,
  totalPages: number,
  stage: PhotonProgressStage
) => void;

const yieldToUi = async () => {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
};

export interface CondenseCustomSettings {
  imageQuality?: number;
  dpiTarget?: number;
  dpiThreshold?: number;
  removeMetadata?: boolean;
  subsetFonts?: boolean;
  convertToGrayscale?: boolean;
  removeThumbnails?: boolean;
}

export async function performCondenseCompression(
  fileBlob: Blob,
  level: string,
  customSettings?: CondenseCustomSettings
) {
  const pymupdf = await loadPyMuPDF();

  const preset =
    CONDENSE_PRESETS[level as keyof typeof CONDENSE_PRESETS] ||
    CONDENSE_PRESETS.balanced;

  const dpiTarget = customSettings?.dpiTarget ?? preset.images.dpiTarget;
  const userThreshold =
    customSettings?.dpiThreshold ?? preset.images.dpiThreshold;
  const dpiThreshold = Math.max(userThreshold, dpiTarget + 10);

  const options = {
    images: {
      enabled: true,
      quality: customSettings?.imageQuality ?? preset.images.quality,
      dpiTarget,
      dpiThreshold,
      convertToGray: customSettings?.convertToGrayscale ?? false,
    },
    scrub: {
      metadata: customSettings?.removeMetadata ?? preset.scrub.metadata,
      thumbnails: customSettings?.removeThumbnails ?? preset.scrub.thumbnails,
      xmlMetadata:
        ('xmlMetadata' in preset.scrub
          ? (preset.scrub as { xmlMetadata?: boolean }).xmlMetadata
          : undefined) ?? false,
    },
    subsetFonts: customSettings?.subsetFonts ?? preset.subsetFonts,
    save: {
      garbage: 4 as const,
      deflate: true,
      clean: true,
      useObjstms: true,
    },
  };

  try {
    const result = await pymupdf.compressPdf(fileBlob, options);
    return result;
  } catch {
    const fallbackOptions = {
      ...options,
      images: {
        ...options.images,
        enabled: false,
      },
    };

    try {
      const result = await pymupdf.compressPdf(fileBlob, fallbackOptions);
      return { ...result, usedFallback: true };
    } catch (fallbackError: unknown) {
      const msg =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(`PDF compression failed: ${msg}`, {
        cause: fallbackError,
      });
    }
  }
}

export async function performPhotonCompression(
  arrayBuffer: ArrayBuffer,
  level: string,
  onProgress?: PhotonProgressCallback
): Promise<Uint8Array> {
  const pdfJsDoc = await getPDFDocument({ data: arrayBuffer }).promise;

  try {
    const newPdfDoc = await PDFDocument.create();
    const settings =
      PHOTON_PRESETS[level as keyof typeof PHOTON_PRESETS] ||
      PHOTON_PRESETS.balanced;
    const totalPages = pdfJsDoc.numPages;

    onProgress?.(0, totalPages, 'preparing');
    await yieldToUi();

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const outputViewport = page.getViewport({ scale: settings.scale });
      const renderScaleFactor = Math.min(
        1,
        Math.sqrt(
          PHOTON_MAX_RENDER_PIXELS /
            Math.max(1, outputViewport.width * outputViewport.height)
        )
      );
      const viewport =
        renderScaleFactor < 1
          ? page.getViewport({ scale: settings.scale * renderScaleFactor })
          : outputViewport;
      const canvas = document.createElement('canvas');
      try {
        onProgress?.(i, totalPages, 'rendering');
        await yieldToUi();

        const context = canvas.getContext('2d');
        if (!context) throw new Error('Failed to create canvas context');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport, canvas }).promise;

        onProgress?.(i, totalPages, 'encoding');
        await yieldToUi();
        const jpegBlob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) => {
              if (blob) resolve(blob);
              else reject(new Error('Failed to create JPEG blob'));
            },
            'image/jpeg',
            settings.quality
          )
        );

        onProgress?.(i, totalPages, 'embedding');
        await yieldToUi();
        const jpegBytes = await jpegBlob.arrayBuffer();
        const jpegImage = await newPdfDoc.embedJpg(jpegBytes);
        const newPage = newPdfDoc.addPage([
          outputViewport.width,
          outputViewport.height,
        ]);
        newPage.drawImage(jpegImage, {
          x: 0,
          y: 0,
          width: outputViewport.width,
          height: outputViewport.height,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }

    onProgress?.(totalPages, totalPages, 'finalizing');
    await yieldToUi();
    return await newPdfDoc.save();
  } finally {
    await pdfJsDoc.destroy();
  }
}
