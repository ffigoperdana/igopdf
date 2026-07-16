import { showLoader, hideLoader, showAlert } from '../ui.js';
import {
  downloadFile,
  readFileAsArrayBuffer,
  formatBytes,
  getPDFDocument,
} from '../utils/helpers.js';
import { loadPdfWithPasswordPrompt } from '../utils/password-prompt.js';
import { state } from '../state.js';
import { PDFDocument } from 'pdf-lib';
import { createIcons, icons } from 'lucide';
import { showWasmRequiredDialog } from '../utils/wasm-provider.js';
import { loadPyMuPDF, isPyMuPDFAvailable } from '../utils/pymupdf-loader.js';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Upload as TusUpload } from 'tus-js-client';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const CONDENSE_PRESETS = {
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

const PHOTON_PRESETS = {
  light: { scale: 2.0, quality: 0.85 },
  balanced: { scale: 1.5, quality: 0.65 },
  aggressive: { scale: 1.2, quality: 0.45 },
  extreme: { scale: 1.0, quality: 0.25 },
};

interface ServerCompressionConfig {
  enabled: boolean;
  clientThresholdBytes: number;
  balancedMaxBytes: number;
  maxUploadBytes: number;
  uploadChunkBytes: number;
}

interface ServerCompressionJob {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  errorCode: string | null;
}

interface CompressionUploadSlot {
  id: string;
  status: 'waiting' | 'ready' | 'uploading' | 'processing';
  jobId: string | null;
  mode: 'lossless' | 'balanced';
  inputBytes: number;
  queuePosition: number;
}

const DEFAULT_SERVER_COMPRESSION_CONFIG: ServerCompressionConfig = {
  enabled: false,
  clientThresholdBytes: 100 * 1024 * 1024,
  balancedMaxBytes: 500 * 1024 * 1024,
  maxUploadBytes: 1024 * 1024 * 1024,
  uploadChunkBytes: 25 * 1024 * 1024,
};

const PYMUDF_MEMORY_ERROR = /memoryerror|out of memory|fzerror.*memory/i;
const RESUMABLE_UPLOAD_INTERRUPTED = 'RESUMABLE_UPLOAD_INTERRUPTED';

function isPyMuPdfMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PYMUDF_MEMORY_ERROR.test(message);
}

async function performCondenseCompression(
  fileBlob: Blob,
  level: string,
  customSettings?: {
    imageQuality?: number;
    dpiTarget?: number;
    dpiThreshold?: number;
    removeMetadata?: boolean;
    subsetFonts?: boolean;
    convertToGrayscale?: boolean;
    removeThumbnails?: boolean;
  }
) {
  // Load PyMuPDF dynamically from user-provided URL
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
        'xmlMetadata' in preset.scrub
          ? (preset.scrub as { xmlMetadata: boolean }).xmlMetadata
          : false,
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isPyMuPdfMemoryError(error)) {
      throw new Error('CONDENSE_MEMORY_LIMIT', { cause: error });
    }

    if (
      errorMessage.includes('PatternType') ||
      errorMessage.includes('pattern')
    ) {
      console.warn(
        '[CompressPDF] Pattern error detected, retrying without image rewriting:',
        errorMessage
      );

      const fallbackOptions = {
        ...options,
        images: {
          ...options.images,
          enabled: false,
        },
      };

      const result = await pymupdf.compressPdf(fileBlob, fallbackOptions);
      return { ...result, usedFallback: true };
    }

    throw new Error(`PDF compression failed: ${errorMessage}`, {
      cause: error,
    });
  }
}

async function performPhotonCompression(
  arrayBuffer: ArrayBuffer,
  level: string,
  file?: File
) {
  let pdfJsDoc: PDFDocumentProxy;
  if (file) {
    hideLoader();
    const result = await loadPdfWithPasswordPrompt(file);
    if (!result) return null;
    showLoader('Running Photon compression...');
    pdfJsDoc = result.pdf;
  } else {
    pdfJsDoc = await getPDFDocument({ data: arrayBuffer }).promise;
  }
  const newPdfDoc = await PDFDocument.create();
  const settings =
    PHOTON_PRESETS[level as keyof typeof PHOTON_PRESETS] ||
    PHOTON_PRESETS.balanced;

  try {
    for (let i = 1; i <= pdfJsDoc.numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const viewport = page.getViewport({ scale: settings.scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create a canvas for this PDF');

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: context, viewport, canvas }).promise;

      const jpegBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Could not encode this PDF page'));
          },
          'image/jpeg',
          settings.quality
        )
      );
      canvas.width = 0;
      canvas.height = 0;

      const jpegBytes = await jpegBlob.arrayBuffer();
      const jpegImage = await newPdfDoc.embedJpg(jpegBytes);
      const newPage = newPdfDoc.addPage([viewport.width, viewport.height]);
      newPage.drawImage(jpegImage, {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      });
    }
    return await newPdfDoc.save();
  } finally {
    await pdfJsDoc.destroy();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const compressOptions = document.getElementById('compress-options');
  const addMoreBtn = document.getElementById('add-more-btn');
  const clearFilesBtn = document.getElementById('clear-files-btn');
  const processBtn = document.getElementById('process-btn');
  const backBtn = document.getElementById('back-to-tools');
  const algorithmSelect = document.getElementById(
    'compression-algorithm'
  ) as HTMLSelectElement;
  const condenseInfo = document.getElementById('condense-info');
  const photonInfo = document.getElementById('photon-info');
  const toggleCustomSettings = document.getElementById(
    'toggle-custom-settings'
  );
  const customSettingsPanel = document.getElementById('custom-settings-panel');
  const customSettingsChevron = document.getElementById(
    'custom-settings-chevron'
  );
  const grayscaleSettings = document.getElementById('grayscale-settings');
  const advancedSettings = document.getElementById('advanced-settings');
  const serverStatus = document.getElementById('server-compression-status');
  const serverStatusText = document.getElementById(
    'server-compression-status-text'
  );
  const cancelServerCompressionBtn = document.getElementById(
    'cancel-server-compression'
  ) as HTMLButtonElement | null;
  const serverCompressionNotice = document.getElementById(
    'server-compression-notice'
  );
  const serverProgressTrack = document.getElementById(
    'server-compression-progress-track'
  );
  const serverProgressBar = document.getElementById(
    'server-compression-progress-bar'
  );
  const serverProgressLabel = document.getElementById(
    'server-compression-progress-label'
  );

  const compressionLevel = document.getElementById(
    'compression-level'
  ) as HTMLSelectElement;
  const clientAlgorithmOptions = Array.from(algorithmSelect.options).map(
    (option) => option.cloneNode(true) as HTMLOptionElement
  );
  const clientLevelOptions = Array.from(compressionLevel.options).map(
    (option) => option.cloneNode(true) as HTMLOptionElement
  );
  let serverConfig = { ...DEFAULT_SERVER_COMPRESSION_CONFIG };
  let activeServerJobId: string | null = null;
  let activeServerUploadSlotId: string | null = null;
  let activeTusUpload: TusUpload | null = null;
  let rejectActiveTusUpload: ((error: Error) => void) | null = null;
  let serverJobCancelled = false;

  let useCustomSettings = false;

  const replaceOptions = (
    select: HTMLSelectElement,
    options: ReadonlyArray<HTMLOptionElement>
  ) => {
    select.replaceChildren(...options.map((option) => option.cloneNode(true)));
  };

  const setOptions = (
    select: HTMLSelectElement,
    options: ReadonlyArray<{ value: string; label: string }>
  ) => {
    select.replaceChildren(
      ...options.map(({ value, label }) => new Option(label, value))
    );
  };

  const getLargeFile = (): File | null => {
    if (state.files.length !== 1) return null;
    const [file] = state.files;
    return file.size > serverConfig.clientThresholdBytes ? file : null;
  };

  const setServerStatus = (
    text: string,
    cancellable: boolean,
    progress: number | null = null
  ) => {
    if (!serverStatus || !serverStatusText) return;
    serverStatusText.textContent = text;
    serverStatus.classList.remove('hidden');
    cancelServerCompressionBtn?.classList.toggle('hidden', !cancellable);

    if (!serverProgressBar || !serverProgressLabel || !serverProgressTrack) {
      return;
    }

    if (progress === null) {
      serverProgressBar.style.width = '100%';
      serverProgressBar.classList.add('animate-pulse');
      serverProgressTrack.setAttribute('aria-valuetext', 'In progress');
      serverProgressTrack.removeAttribute('aria-valuenow');
      serverProgressLabel.textContent = 'Processing on the server';
      return;
    }

    const roundedProgress = Math.max(0, Math.min(100, Math.round(progress)));
    serverProgressBar.classList.remove('animate-pulse');
    serverProgressBar.style.width = `${roundedProgress}%`;
    serverProgressTrack.setAttribute('aria-valuenow', String(roundedProgress));
    serverProgressTrack.setAttribute('aria-valuetext', `${roundedProgress}%`);
    serverProgressLabel.textContent = `${roundedProgress}%`;
  };

  const clearServerStatus = () => {
    activeServerJobId = null;
    activeServerUploadSlotId = null;
    activeTusUpload = null;
    rejectActiveTusUpload = null;
    serverJobCancelled = false;
    serverStatus?.classList.add('hidden');
    cancelServerCompressionBtn?.classList.add('hidden');
    if (serverProgressBar) {
      serverProgressBar.classList.remove('animate-pulse');
      serverProgressBar.style.width = '0%';
    }
    if (serverProgressLabel) serverProgressLabel.textContent = '';
  };

  const updateCompressionControls = () => {
    const largeFile = getLargeFile();

    if (!largeFile) {
      replaceOptions(algorithmSelect, clientAlgorithmOptions);
      replaceOptions(compressionLevel, clientLevelOptions);
      compressionLevel.disabled = false;
      grayscaleSettings?.classList.remove('hidden');
      advancedSettings?.classList.remove('hidden');
      condenseInfo?.classList.remove('hidden');
      photonInfo?.classList.add('hidden');
      serverCompressionNotice?.classList.add('hidden');
      processBtn?.removeAttribute('disabled');
      return;
    }

    if (!serverConfig.enabled) {
      setOptions(algorithmSelect, [
        {
          value: 'server-unavailable',
          label: 'Server queue unavailable',
        },
      ]);
      algorithmSelect.disabled = true;
      setOptions(compressionLevel, [
        { value: 'unavailable', label: 'Unavailable' },
      ]);
      compressionLevel.disabled = true;
      grayscaleSettings?.classList.add('hidden');
      advancedSettings?.classList.add('hidden');
      condenseInfo?.classList.add('hidden');
      photonInfo?.classList.add('hidden');
      serverCompressionNotice?.classList.add('hidden');
      processBtn?.setAttribute('disabled', 'true');
      return;
    }

    const balancedAllowed = largeFile.size <= serverConfig.balancedMaxBytes;
    setOptions(algorithmSelect, [
      { value: 'server-lossless', label: 'Lossless (Server)' },
      ...(balancedAllowed
        ? [{ value: 'server-balanced', label: 'Balanced (Server)' }]
        : []),
    ]);
    algorithmSelect.disabled = false;
    setOptions(compressionLevel, [{ value: 'light', label: 'Server-managed' }]);
    compressionLevel.disabled = true;
    grayscaleSettings?.classList.add('hidden');
    advancedSettings?.classList.add('hidden');
    condenseInfo?.classList.add('hidden');
    photonInfo?.classList.add('hidden');
    serverCompressionNotice?.classList.remove('hidden');
    processBtn?.removeAttribute('disabled');
  };

  const fetchServerCompressionConfig = async () => {
    try {
      const response = await fetch('/api/compression/config', {
        credentials: 'include',
      });
      const payload = (await response.json()) as {
        success?: boolean;
        data?: Partial<ServerCompressionConfig>;
      };
      if (response.ok && payload.success && payload.data) {
        serverConfig = { ...serverConfig, ...payload.data };
      }
    } catch {
      // A large file remains blocked if the authenticated server cannot be reached.
    } finally {
      updateCompressionControls();
    }
  };

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = import.meta.env.BASE_URL;
    });
  }

  // Toggle algorithm info
  if (algorithmSelect && condenseInfo && photonInfo) {
    algorithmSelect.addEventListener('change', () => {
      if (algorithmSelect.value.startsWith('server-')) {
        condenseInfo.classList.add('hidden');
        photonInfo.classList.add('hidden');
      } else if (algorithmSelect.value === 'condense') {
        condenseInfo.classList.remove('hidden');
        photonInfo.classList.add('hidden');
      } else {
        condenseInfo.classList.add('hidden');
        photonInfo.classList.remove('hidden');
      }
    });
  }

  // Toggle custom settings panel
  if (toggleCustomSettings && customSettingsPanel && customSettingsChevron) {
    toggleCustomSettings.addEventListener('click', () => {
      customSettingsPanel.classList.toggle('hidden');
      customSettingsChevron.style.transform =
        customSettingsPanel.classList.contains('hidden')
          ? 'rotate(0deg)'
          : 'rotate(180deg)';
      // Mark that user wants to use custom settings
      if (!customSettingsPanel.classList.contains('hidden')) {
        useCustomSettings = true;
      }
    });
  }

  const updateUI = async () => {
    if (!compressOptions) return;

    if (state.files.length > 0) {
      const fileDisplayArea = document.getElementById('file-display-area');
      if (fileDisplayArea) {
        fileDisplayArea.innerHTML = '';

        for (let index = 0; index < state.files.length; index++) {
          const file = state.files[index];
          const fileDiv = document.createElement('div');
          fileDiv.className =
            'flex items-center justify-between bg-surface-muted p-3 rounded-lg text-sm';

          const infoContainer = document.createElement('div');
          infoContainer.className = 'flex flex-col overflow-hidden';

          const nameSpan = document.createElement('div');
          nameSpan.className = 'truncate font-medium text-content text-sm mb-1';
          nameSpan.textContent = file.name;

          const metaSpan = document.createElement('div');
          metaSpan.className = 'text-xs text-content-muted';
          metaSpan.textContent = formatBytes(file.size);

          infoContainer.append(nameSpan, metaSpan);

          const removeBtn = document.createElement('button');
          removeBtn.className =
            'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
          removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
          removeBtn.onclick = () => {
            state.files = state.files.filter((_, i) => i !== index);
            updateUI();
          };

          fileDiv.append(infoContainer, removeBtn);
          fileDisplayArea.appendChild(fileDiv);
        }

        createIcons({ icons });
      }
      compressOptions.classList.remove('hidden');
      updateCompressionControls();
    } else {
      compressOptions.classList.add('hidden');
      // Clear file display area
      const fileDisplayArea = document.getElementById('file-display-area');
      if (fileDisplayArea) fileDisplayArea.innerHTML = '';
      updateCompressionControls();
    }
  };

  const resetState = () => {
    state.files = [];
    state.pdfDoc = null;

    const compressionLevel = document.getElementById(
      'compression-level'
    ) as HTMLSelectElement;
    if (compressionLevel) compressionLevel.value = 'balanced';

    if (algorithmSelect) algorithmSelect.value = 'condense';

    useCustomSettings = false;
    if (customSettingsPanel) customSettingsPanel.classList.add('hidden');
    if (customSettingsChevron)
      customSettingsChevron.style.transform = 'rotate(0deg)';

    const imageQuality = document.getElementById(
      'image-quality'
    ) as HTMLInputElement;
    const dpiTarget = document.getElementById('dpi-target') as HTMLInputElement;
    const dpiThreshold = document.getElementById(
      'dpi-threshold'
    ) as HTMLInputElement;
    const removeMetadata = document.getElementById(
      'remove-metadata'
    ) as HTMLInputElement;
    const subsetFonts = document.getElementById(
      'subset-fonts'
    ) as HTMLInputElement;
    const convertToGrayscale = document.getElementById(
      'convert-to-grayscale'
    ) as HTMLInputElement;
    const removeThumbnails = document.getElementById(
      'remove-thumbnails'
    ) as HTMLInputElement;

    if (imageQuality) imageQuality.value = '75';
    if (dpiTarget) dpiTarget.value = '96';
    if (dpiThreshold) dpiThreshold.value = '150';
    if (removeMetadata) removeMetadata.checked = true;
    if (subsetFonts) subsetFonts.checked = true;
    if (convertToGrayscale) convertToGrayscale.checked = false;
    if (removeThumbnails) removeThumbnails.checked = true;

    if (condenseInfo) condenseInfo.classList.remove('hidden');
    if (photonInfo) photonInfo.classList.add('hidden');

    clearServerStatus();
    updateUI();
  };

  const readApiError = async (response: Response): Promise<string> => {
    try {
      const payload = (await response.json()) as { error?: string };
      return payload.error || 'Server compression could not be started';
    } catch {
      return 'Server compression could not be started';
    }
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const downloadServerResult = async (jobId: string, file: File) => {
    const response = await fetch(`/api/compression/jobs/${jobId}/download`, {
      credentials: 'include',
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const result = await response.blob();
    const outputName = file.name.replace(/\.pdf$/i, '_compressed.pdf');
    downloadFile(result, outputName);
  };

  const reserveServerUploadSlot = async (
    mode: 'lossless' | 'balanced',
    inputBytes: number
  ) => {
    const response = await fetch('/api/compression/upload-slots', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, inputBytes }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = (await response.json()) as {
      data?: { slot?: CompressionUploadSlot };
    };
    if (!payload.data?.slot)
      throw new Error('Server queue reservation is unavailable');
    return payload.data.slot;
  };

  const fetchServerUploadSlot = async (slotId: string) => {
    const response = await fetch(`/api/compression/upload-slots/${slotId}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = (await response.json()) as {
      data?: { slot?: CompressionUploadSlot };
    };
    if (!payload.data?.slot)
      throw new Error('Server queue reservation is unavailable');
    return payload.data.slot;
  };

  const resetServerUpload = async (slotId: string) => {
    const response = await fetch(
      `/api/compression/upload-slots/${slotId}/reset`,
      {
        method: 'POST',
        credentials: 'include',
      }
    );
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = (await response.json()) as {
      data?: { slot?: CompressionUploadSlot };
    };
    if (!payload.data?.slot)
      throw new Error('The interrupted upload could not be restarted');
    return payload.data.slot;
  };

  const releaseServerUploadSlot = async () => {
    if (!activeServerUploadSlotId) return;
    const slotId = activeServerUploadSlotId;
    activeServerUploadSlotId = null;
    await fetch(`/api/compression/upload-slots/${slotId}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch((): undefined => undefined);
  };

  const waitForServerUploadTurn = async (
    file: File,
    mode: 'lossless' | 'balanced'
  ) => {
    const slot = await reserveServerUploadSlot(mode, file.size);
    activeServerUploadSlotId = slot.id;
    let current = slot;
    while (current.status === 'waiting') {
      if (serverJobCancelled)
        throw new Error('Server compression was cancelled');
      setServerStatus(
        `Waiting in server upload queue. Position ${current.queuePosition}.`,
        true,
        null
      );
      await wait(2000);
      if (serverJobCancelled)
        throw new Error('Server compression was cancelled');
      current = await fetchServerUploadSlot(slot.id);
    }
    if (serverJobCancelled) throw new Error('Server compression was cancelled');
    if (current.status === 'processing') {
      setServerStatus(
        'Upload complete. Waiting for server processing...',
        true,
        null
      );
    } else if (current.status === 'uploading') {
      setServerStatus('Resuming the interrupted PDF upload...', true, 0);
    } else {
      setServerStatus(
        'Your server queue turn has started. Uploading PDF...',
        true,
        0
      );
    }
    return current;
  };

  const uploadTusOnce = async (
    file: File,
    slot: CompressionUploadSlot,
    mode: 'lossless' | 'balanced'
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const upload = new TusUpload(file, {
        endpoint: '/api/compression/uploads',
        uploadUrl:
          slot.status === 'uploading'
            ? `/api/compression/uploads/${slot.id}`
            : null,
        chunkSize: serverConfig.uploadChunkBytes,
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
        parallelUploads: 1,
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: true,
        metadata: {
          slotId: slot.id,
          mode,
          filename: file.name,
          filetype: 'application/pdf',
        },
        onProgress: (bytesSent, bytesTotal) => {
          if (serverJobCancelled || bytesTotal <= 0) return;
          const progress = (bytesSent / bytesTotal) * 100;
          setServerStatus(
            `Uploading ${formatBytes(bytesSent)} of ${formatBytes(bytesTotal)}.`,
            true,
            progress
          );
        },
        onSuccess: ({ lastResponse }) => {
          if (activeTusUpload === upload) activeTusUpload = null;
          rejectActiveTusUpload = null;
          resolve(lastResponse.getHeader('Upload-Job-Id') || slot.id);
        },
        onError: (error) => {
          if (activeTusUpload === upload) activeTusUpload = null;
          rejectActiveTusUpload = null;
          reject(
            serverJobCancelled
              ? new Error('Server compression was cancelled')
              : error
          );
        },
      });
      activeTusUpload = upload;
      rejectActiveTusUpload = reject;
      upload.start();
    });

  const uploadServerFile = async (
    file: File,
    initialSlot: CompressionUploadSlot,
    mode: 'lossless' | 'balanced'
  ): Promise<string> => {
    let slot = initialSlot;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (serverJobCancelled)
        throw new Error('Server compression was cancelled');
      if (slot.status === 'processing') return slot.jobId || slot.id;

      try {
        return await uploadTusOnce(file, slot, mode);
      } catch (error) {
        lastError = error;
        if (serverJobCancelled) throw error;

        // A proxy can drop the response after the backend has already accepted
        // a chunk or even finalized the upload. Resolve the durable slot before
        // deciding whether to resume, restart, or proceed to job polling.
        slot = await fetchServerUploadSlot(slot.id);
        if (slot.status === 'processing') return slot.jobId || slot.id;

        if (slot.status === 'uploading' && attempt === 1) {
          slot = await resetServerUpload(slot.id);
        }
      }
    }

    console.warn('[CompressPDF] Resumable upload exhausted retries', lastError);
    throw new Error(RESUMABLE_UPLOAD_INTERRUPTED);
  };

  const runServerCompression = async (file: File) => {
    if (!serverConfig.enabled) {
      throw new Error('Server-side compression is currently unavailable');
    }
    if (file.size > serverConfig.maxUploadBytes) {
      throw new Error('Ukuran maksimum untuk kompresi adalah 1 GB');
    }

    const mode =
      algorithmSelect.value === 'server-balanced' ? 'balanced' : 'lossless';
    const slot = await waitForServerUploadTurn(file, mode);
    const jobId = await uploadServerFile(file, slot, mode);

    activeServerJobId = jobId;
    activeServerUploadSlotId = null;

    while (activeServerJobId === jobId && !serverJobCancelled) {
      const statusResponse = await fetch(`/api/compression/jobs/${jobId}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!statusResponse.ok)
        throw new Error(await readApiError(statusResponse));
      const statusPayload = (await statusResponse.json()) as {
        data?: { job?: ServerCompressionJob; queuePosition?: number | null };
      };
      const current = statusPayload.data?.job;
      if (!current) throw new Error('Server job status is unavailable');

      if (current.status === 'queued') {
        const position = statusPayload.data?.queuePosition;
        setServerStatus(
          position && position > 1
            ? `Waiting in server queue. Position ${position}.`
            : 'Waiting for the server worker to start compression.',
          true,
          null
        );
      } else if (current.status === 'processing') {
        setServerStatus(
          'Compressing on the server. Keep this page open.',
          true,
          null
        );
      } else if (current.status === 'completed') {
        setServerStatus('Preparing secure download...', false, 100);
        await downloadServerResult(jobId, file);
        clearServerStatus();
        showAlert(
          'Compression Complete',
          'The server-side compression result has been downloaded. The temporary server files have been removed.',
          'success',
          () => resetState()
        );
        return;
      } else if (current.status === 'cancelled') {
        throw new Error('Server compression was cancelled');
      } else {
        const detail =
          current.errorCode === 'TIMEOUT'
            ? 'The server reached its processing time limit.'
            : current.errorCode === 'MEMORY_LIMIT'
              ? 'This image-heavy PDF exceeded the server memory limit. Retry with Lossless (Server).'
              : 'The server could not compress this PDF.';
        throw new Error(detail);
      }
      await wait(2000);
    }
    if (serverJobCancelled) throw new Error('Server compression was cancelled');
  };

  const compress = async () => {
    const level = (
      document.getElementById('compression-level') as HTMLSelectElement
    ).value;
    const convertToGrayscale =
      (document.getElementById('convert-to-grayscale') as HTMLInputElement)
        ?.checked ?? false;

    let customSettings:
      | {
          imageQuality?: number;
          dpiTarget?: number;
          dpiThreshold?: number;
          removeMetadata?: boolean;
          subsetFonts?: boolean;
          convertToGrayscale?: boolean;
          removeThumbnails?: boolean;
        }
      | undefined;

    if (useCustomSettings) {
      const imageQuality =
        parseInt(
          (document.getElementById('image-quality') as HTMLInputElement)?.value
        ) || 75;
      const dpiTarget =
        parseInt(
          (document.getElementById('dpi-target') as HTMLInputElement)?.value
        ) || 96;
      const dpiThreshold =
        parseInt(
          (document.getElementById('dpi-threshold') as HTMLInputElement)?.value
        ) || 150;
      const removeMetadata =
        (document.getElementById('remove-metadata') as HTMLInputElement)
          ?.checked ?? true;
      const subsetFonts =
        (document.getElementById('subset-fonts') as HTMLInputElement)
          ?.checked ?? true;
      const removeThumbnails =
        (document.getElementById('remove-thumbnails') as HTMLInputElement)
          ?.checked ?? true;

      customSettings = {
        imageQuality,
        dpiTarget,
        dpiThreshold,
        removeMetadata,
        subsetFonts,
        convertToGrayscale,
        removeThumbnails,
      };
    } else {
      customSettings = convertToGrayscale ? { convertToGrayscale } : undefined;
    }

    try {
      if (state.files.length === 0) {
        showAlert('No Files', 'Please select at least one PDF file.');
        hideLoader();
        return;
      }

      const serverFile = getLargeFile();
      if (serverFile) {
        await runServerCompression(serverFile);
        return;
      }

      // Check WASM availability for Condense mode
      const algorithm = (
        document.getElementById('compression-algorithm') as HTMLSelectElement
      ).value;
      if (algorithm === 'condense' && !isPyMuPDFAvailable()) {
        showWasmRequiredDialog('pymupdf');
        return;
      }

      if (state.files.length === 1) {
        const originalFile = state.files[0];

        let resultBlob: Blob;
        let resultSize: number;
        let usedMethod: string;

        if (algorithm === 'condense') {
          showLoader('Running Condense compression...');
          const result = await performCondenseCompression(
            originalFile,
            level,
            customSettings
          );
          resultBlob = result.blob;
          resultSize = result.compressedSize;
          usedMethod = 'Condense';

          // Check if fallback was used
          if ((result as { usedFallback?: boolean }).usedFallback) {
            usedMethod +=
              ' (without image optimization due to unsupported patterns)';
          }
        } else {
          showLoader('Running Photon compression...');
          const arrayBuffer = (await readFileAsArrayBuffer(
            originalFile
          )) as ArrayBuffer;
          const resultBytes = await performPhotonCompression(
            arrayBuffer,
            level,
            originalFile
          );
          if (!resultBytes) return;
          const buffer = resultBytes.buffer.slice(
            resultBytes.byteOffset,
            resultBytes.byteOffset + resultBytes.byteLength
          ) as ArrayBuffer;
          resultBlob = new Blob([buffer], { type: 'application/pdf' });
          resultSize = resultBytes.length;
          usedMethod = 'Photon';
        }

        const originalSize = formatBytes(originalFile.size);
        const compressedSize = formatBytes(resultSize);
        const savings = originalFile.size - resultSize;
        const savingsPercent =
          savings > 0 ? ((savings / originalFile.size) * 100).toFixed(1) : 0;

        downloadFile(resultBlob, originalFile.name);

        hideLoader();

        if (savings > 0) {
          showAlert(
            'Compression Complete',
            `Method: ${usedMethod}. File size reduced from ${originalSize} to ${compressedSize} (Saved ${savingsPercent}%).`,
            'success',
            () => resetState()
          );
        } else {
          showAlert(
            'Compression Finished',
            `Method: ${usedMethod}. Could not reduce file size further. Original: ${originalSize}, New: ${compressedSize}.`,
            'warning',
            () => resetState()
          );
        }
      } else {
        showLoader('Compressing multiple PDFs...');
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        let totalOriginalSize = 0;
        let totalCompressedSize = 0;

        for (let i = 0; i < state.files.length; i++) {
          const file = state.files[i];
          showLoader(
            `Compressing ${i + 1}/${state.files.length}: ${file.name}...`
          );
          totalOriginalSize += file.size;

          let resultBytes: Uint8Array;
          if (algorithm === 'condense') {
            const result = await performCondenseCompression(
              file,
              level,
              customSettings
            );
            resultBytes = new Uint8Array(await result.blob.arrayBuffer());
          } else {
            const arrayBuffer = (await readFileAsArrayBuffer(
              file
            )) as ArrayBuffer;
            const photonResult = await performPhotonCompression(
              arrayBuffer,
              level,
              file
            );
            if (!photonResult) return;
            resultBytes = photonResult;
          }

          totalCompressedSize += resultBytes.length;
          zip.file(file.name, resultBytes);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const totalSavings = totalOriginalSize - totalCompressedSize;
        const totalSavingsPercent =
          totalSavings > 0
            ? ((totalSavings / totalOriginalSize) * 100).toFixed(1)
            : 0;

        downloadFile(zipBlob, 'compressed-pdfs.zip');

        hideLoader();

        if (totalSavings > 0) {
          showAlert(
            'Compression Complete',
            `Compressed ${state.files.length} PDF(s). Total size reduced from ${formatBytes(totalOriginalSize)} to ${formatBytes(totalCompressedSize)} (Saved ${totalSavingsPercent}%).`,
            'success',
            () => resetState()
          );
        } else {
          showAlert(
            'Compression Finished',
            `Compressed ${state.files.length} PDF(s). Total size: ${formatBytes(totalCompressedSize)}.`,
            'info',
            () => resetState()
          );
        }
      }
    } catch (e: unknown) {
      hideLoader();
      await releaseServerUploadSlot();
      clearServerStatus();
      console.error('[CompressPDF] Error:', e);
      if (
        e instanceof Error &&
        e.message === 'Server compression was cancelled'
      ) {
        showAlert(
          'Compression cancelled',
          'The upload or server job was cancelled and its temporary files are being removed.',
          'info'
        );
        return;
      }
      if (
        e instanceof Error &&
        (e.message === 'CONDENSE_MEMORY_LIMIT' || isPyMuPdfMemoryError(e))
      ) {
        showAlert(
          'PDF terlalu besar atau kompleks untuk Condense',
          'PDF tidak diubah. Pilih Photon untuk memproses dokumen ini dengan kebutuhan memori yang lebih stabil. Photon mengubah setiap halaman menjadi gambar, sehingga teks dan tautan tidak lagi dapat dipilih.'
        );
        return;
      }
      if (e instanceof Error && e.message === RESUMABLE_UPLOAD_INTERRUPTED) {
        showAlert(
          'Upload could not be resumed',
          'The connection was retried and resumed automatically, but the upload still could not finish. Please retry the operation once. If it happens again, contact your administrator and include the time of the attempt.'
        );
        return;
      }
      showAlert(
        'Error',
        `An error occurred during compression. Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const selectedFiles = Array.from(files);
    const tooLarge = selectedFiles.find(
      (file) => file.size > serverConfig.maxUploadBytes
    );
    if (tooLarge) {
      showAlert(
        'File too large',
        'Ukuran maksimum untuk kompresi adalah 1 GB. File tidak diunggah atau diproses.'
      );
      return;
    }

    const includesServerFile = selectedFiles.some(
      (file) => file.size > serverConfig.clientThresholdBytes
    );
    if (
      includesServerFile &&
      (selectedFiles.length > 1 || state.files.length > 0)
    ) {
      showAlert(
        'One large PDF at a time',
        'PDF di atas 100 MB diproses melalui antrean server. Pilih satu file besar dalam satu proses.'
      );
      return;
    }

    state.files = [...state.files, ...selectedFiles];
    updateUI();
  };

  if (fileInput && dropZone) {
    fileInput.addEventListener('change', (e) => {
      handleFileSelect((e.target as HTMLInputElement).files);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-surface-muted');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-surface-muted');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-surface-muted');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const pdfFiles = Array.from(files).filter(
          (f) => f.type === 'application/pdf'
        );
        if (pdfFiles.length > 0) {
          const dataTransfer = new DataTransfer();
          pdfFiles.forEach((f) => dataTransfer.items.add(f));
          handleFileSelect(dataTransfer.files);
        }
      }
    });

    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
  }

  if (addMoreBtn) {
    addMoreBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (clearFilesBtn) {
    clearFilesBtn.addEventListener('click', () => {
      resetState();
    });
  }

  if (cancelServerCompressionBtn) {
    cancelServerCompressionBtn.addEventListener('click', async () => {
      if (!activeServerJobId && !activeServerUploadSlotId) return;
      cancelServerCompressionBtn.disabled = true;
      serverJobCancelled = true;
      try {
        if (activeServerJobId) {
          await fetch(`/api/compression/jobs/${activeServerJobId}`, {
            method: 'DELETE',
            credentials: 'include',
          });
        } else {
          const upload = activeTusUpload;
          const rejectUpload = rejectActiveTusUpload;
          activeTusUpload = null;
          rejectActiveTusUpload = null;
          await upload?.abort(true).catch((): undefined => undefined);
          rejectUpload?.(new Error('Server compression was cancelled'));
          await releaseServerUploadSlot();
        }
        setServerStatus(
          'Cancellation requested. Cleaning up the temporary server files...',
          false
        );
      } finally {
        cancelServerCompressionBtn.disabled = false;
      }
    });
  }

  if (processBtn) {
    processBtn.addEventListener('click', compress);
  }

  void fetchServerCompressionConfig();
});
