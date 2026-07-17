import { showAlert, showLoader, hideLoader } from '../ui.js';
import { initI18n, t } from '../i18n/i18n.js';
import {
  downloadFile,
  formatBytes,
  getPDFDocument,
  readFileAsArrayBuffer,
} from '../utils/helpers.js';
import { state } from '../state.js';
import { createIcons, icons } from 'lucide';
import { loadPyMuPDF } from '../utils/pymupdf-loader.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { deduplicateFileName } from '../utils/deduplicate-filename.js';
import { Upload as TusUpload } from 'tus-js-client';

type DocxMode = 'auto' | 'editable' | 'ocr' | 'visual';
type ServerDocxMode = Exclude<DocxMode, 'auto'>;
type TextLayerKind = 'native' | 'mixed' | 'image';

type PdfTextLayerProfile = {
  pageCount: number;
  samplePages: number;
  imageBasedPages: number;
  kind: TextLayerKind;
};

type ServerDocxConfig = {
  enabled: boolean;
  clientMaxBytes: number;
  maxUploadBytes: number;
  nativeMaxPages: number;
  ocrMaxPages: number;
  visualMaxPages: number;
  uploadChunkBytes: number;
};

type UploadSlot = {
  id: string;
  status: 'ready' | 'uploading' | 'processing';
  jobId: string | null;
};

type ServerJob = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  currentPage: number | null;
  totalPages: number | null;
  errorCode: string | null;
};

const DEFAULT_CONFIG: ServerDocxConfig = {
  enabled: false,
  clientMaxBytes: 50 * 1024 * 1024,
  maxUploadBytes: 50 * 1024 * 1024,
  nativeMaxPages: 200,
  ocrMaxPages: 100,
  visualMaxPages: 100,
  uploadChunkBytes: 10 * 1024 * 1024,
};

const profiles = new WeakMap<File, PdfTextLayerProfile>();

function translated(key: string, fallback: string, options?: Record<string, unknown>): string {
  const value = t(key, options);
  return value === key ? fallback : value;
}

function knownStructureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /object out of range|xref|extract_font|FzErrorFormat|font/i.test(message);
}

function friendlyServerError(code: string | null): string {
  switch (code) {
    case 'INVALID_PDF_STRUCTURE':
      return translated('pdfToWord.errors.invalidStructure', 'This PDF has an invalid internal structure. The repair attempt could not make it convertible.');
    case 'FONT_OR_LAYOUT_UNSUPPORTED':
      return translated('pdfToWord.errors.fontLayout', 'This PDF uses embedded fonts or layout objects that could not be reconstructed as editable Word content. Try Preserve appearance.');
    case 'ENCRYPTED_PDF':
      return translated('pdfToWord.errors.encrypted', 'Remove the PDF password first, then retry conversion.');
    case 'PAGE_LIMIT':
      return translated('pdfToWord.errors.pageLimit', 'This conversion mode reached its page limit for the current server capacity.');
    case 'MEMORY_LIMIT':
      return translated('pdfToWord.errors.memoryLimit', 'This document is too image-heavy for the current server capacity. Try fewer pages or Preserve appearance.');
    case 'TIMEOUT':
      return translated('pdfToWord.errors.timeout', 'The conversion reached its processing time limit.');
    case 'CANCELLED':
      return translated('pdfToWord.errors.cancelled', 'The conversion was cancelled.');
    default:
      return translated('pdfToWord.errors.general', 'The server could not convert this PDF. Please retry once; if the issue continues, contact the administrator.');
  }
}

async function inspectTextLayer(file: File, source?: ArrayBuffer): Promise<PdfTextLayerProfile> {
  const bytes = source ?? await readFileAsArrayBuffer(file);
  const document = await getPDFDocument({ data: bytes }).promise;
  const pageCount = document.numPages;
  const samplePages = Math.min(pageCount, 5);
  let imageBasedPages = 0;
  try {
    for (let pageNumber = 1; pageNumber <= samplePages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textLength = textContent.items.reduce((total, item) => {
        const text = 'str' in item ? item.str : '';
        return total + text.trim().length;
      }, 0);
      if (textLength < 20) imageBasedPages += 1;
    }
  } finally {
    await document.destroy();
  }
  const kind: TextLayerKind = imageBasedPages === 0
    ? 'native'
    : imageBasedPages === samplePages ? 'image' : 'mixed';
  return { pageCount, samplePages, imageBasedPages, kind };
}

document.addEventListener('DOMContentLoaded', () => {
  void (async () => {
    await initI18n();
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    const dropZone = document.getElementById('drop-zone');
    const processButton = document.getElementById('process-btn') as HTMLButtonElement;
    const fileDisplay = document.getElementById('file-display-area');
    const controls = document.getElementById('file-controls');
    const options = document.getElementById('convert-options');
    const addMoreButton = document.getElementById('add-more-btn');
    const clearFilesButton = document.getElementById('clear-files-btn');
    const modeSelect = document.getElementById('docx-mode') as HTMLSelectElement;
    const modeHelp = document.getElementById('docx-mode-help');
    const privacyHint = document.getElementById('docx-privacy-hint');
    const qualityNotice = document.getElementById('conversion-quality-notice');
    const qualityMessage = document.getElementById('conversion-quality-message');
    const openOcrLink = document.getElementById('conversion-open-ocr') as HTMLAnchorElement | null;
    const serverStatus = document.getElementById('server-conversion-status');
    const serverMessage = document.getElementById('server-conversion-message');
    const serverProgress = document.getElementById('server-conversion-progress') as HTMLProgressElement;
    const cancelServerButton = document.getElementById('cancel-server-conversion') as HTMLButtonElement;
    const backButton = document.getElementById('back-to-tools');

    let serverConfig = { ...DEFAULT_CONFIG };
    let activeSlotId: string | null = null;
    let activeJobId: string | null = null;
    let activeUpload: TusUpload | null = null;
    let cancelRequested = false;

    const currentMode = (): DocxMode => modeSelect.value as DocxMode;
    const firstProfile = (): PdfTextLayerProfile | null => state.files[0] ? profiles.get(state.files[0]) || null : null;

    const resolvedMode = (file: File): ServerDocxMode => {
      const selected = currentMode();
      if (selected !== 'auto') return selected;
      return profiles.get(file)?.kind === 'native' ? 'editable' : 'ocr';
    };

    const setServerStatus = (message: string, progress: number | null, cancellable = false) => {
      if (!serverStatus || !serverMessage || !serverProgress) return;
      serverStatus.classList.remove('hidden');
      serverMessage.textContent = message;
      if (progress === null) serverProgress.removeAttribute('value');
      else serverProgress.value = Math.max(0, Math.min(100, progress));
      cancelServerButton.classList.toggle('hidden', !cancellable);
    };

    const clearServerStatus = () => {
      serverStatus?.classList.add('hidden');
      cancelServerButton.classList.add('hidden');
      if (serverProgress) serverProgress.value = 0;
    };

    const updateModeCopy = () => {
      const profile = firstProfile();
      const selected = currentMode();
      const mode = state.files[0] ? resolvedMode(state.files[0]) : 'editable';
      const help = selected === 'auto'
        ? profile?.kind === 'image'
          ? translated('pdfToWord.mode.autoImage', 'Image-based PDF detected. OCR editable text is recommended.')
          : profile?.kind === 'mixed'
            ? translated('pdfToWord.mode.autoMixed', 'Mixed PDF detected. OCR can recover image-only pages, but layout may change.')
            : translated('pdfToWord.mode.autoNative', 'Native text PDF detected. The browser will try editable conversion first.')
        : mode === 'ocr'
          ? translated('pdfToWord.mode.ocr', 'OCR makes scanned text editable, but words and layout can differ from the PDF.')
          : mode === 'visual'
            ? translated('pdfToWord.mode.visual', 'Each PDF page is placed as an image in Word. Appearance is preserved but text is not editable.')
            : translated('pdfToWord.mode.editable', 'Reconstruct editable Word text. Complex tables, slide layouts, and fonts may change.');
      if (modeHelp) modeHelp.textContent = help;
      if (privacyHint) privacyHint.textContent = serverConfig.enabled
        ? translated('pdfToWord.privacy.hybrid', 'Small native-text PDFs stay in your browser. OCR, repair, and visual fallback use a private temporary server job that is deleted after download or expiry.')
        : translated('pdfToWord.privacy.browser', 'Files are processed in your browser. OCR and server repair are currently unavailable.');
    };

    const updateQualityNotice = () => {
      if (!qualityNotice || !qualityMessage) return;
      const allProfiles = state.files.map((file) => profiles.get(file)).filter((profile): profile is PdfTextLayerProfile => Boolean(profile));
      if (allProfiles.length === 0) { qualityNotice.classList.add('hidden'); return; }
      const imagePages = allProfiles.reduce((total, profile) => total + profile.imageBasedPages, 0);
      const sampledPages = allProfiles.reduce((total, profile) => total + profile.samplePages, 0);
      qualityMessage.textContent = imagePages > 0
        ? translated('pdfToWord.imageBasedDetected', `${imagePages} of ${sampledPages} sampled pages do not have usable text. OCR is recommended for scanned or image-based PDFs.`, { imagePages, samplePages: sampledPages })
        : translated('pdfToWord.nativeTextDetected', 'Usable text was found. Font, table, spacing, and complex layout can still change in DOCX.');
      qualityNotice.classList.remove('hidden');
      if (openOcrLink) {
        openOcrLink.textContent = translated('pdfToWord.openOcr', 'Open OCR PDF');
        openOcrLink.classList.toggle('hidden', imagePages === 0);
      }
    };

    const resetState = () => {
      state.files = [];
      state.pdfDoc = null;
      activeSlotId = null;
      activeJobId = null;
      activeUpload = null;
      cancelRequested = false;
      clearServerStatus();
      void updateUi();
    };

    const updateUi = async () => {
      if (!fileDisplay || !controls || !options) return;
      if (state.files.length === 0) {
        fileDisplay.innerHTML = '';
        controls.classList.add('hidden');
        options.classList.add('hidden');
        processButton.disabled = true;
        qualityNotice?.classList.add('hidden');
        updateModeCopy();
        return;
      }
      fileDisplay.innerHTML = '';
      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between bg-surface-muted p-3 rounded-lg text-sm';
        const info = document.createElement('div');
        info.className = 'flex flex-col overflow-hidden';
        const name = document.createElement('div');
        name.className = 'truncate font-medium text-content text-sm mb-1';
        name.textContent = file.name;
        const meta = document.createElement('div');
        meta.className = 'text-xs text-content-muted';
        meta.textContent = `${formatBytes(file.size)} - ${translated('common.loadingPageCount', 'Checking pages...')}`;
        info.append(name, meta);
        const remove = document.createElement('button');
        remove.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
        remove.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
        remove.onclick = () => { state.files = state.files.filter((_: File, itemIndex: number) => itemIndex !== index); void updateUi(); };
        row.append(info, remove);
        fileDisplay.appendChild(row);
        try {
          const bytes = await readFileAsArrayBuffer(file);
          const profile = await inspectTextLayer(file, bytes);
          profiles.set(file, profile);
          meta.textContent = `${formatBytes(file.size)} - ${profile.pageCount} pages - ${profile.kind === 'native' ? 'text layer' : profile.kind === 'mixed' ? 'mixed content' : 'image-based'}`;
        } catch {
          meta.textContent = `${formatBytes(file.size)} - ${translated('pdfToWord.preflightFailed', 'Could not inspect this PDF. Server repair may still be available.')}`;
        }
      }
      controls.classList.remove('hidden');
      options.classList.remove('hidden');
      processButton.disabled = false;
      updateQualityNotice();
      updateModeCopy();
      createIcons({ icons });
    };

    const readApiError = async (response: Response): Promise<string> => {
      try {
        const payload = await response.json() as { error?: string };
        return payload.error || `Request failed (${response.status})`;
      } catch { return `Request failed (${response.status})`; }
    };

    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/docx/config', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as { data?: Partial<ServerDocxConfig> };
        serverConfig = { ...DEFAULT_CONFIG, ...payload.data };
      } finally {
        updateModeCopy();
      }
    };

    const validateForMode = (file: File, mode: ServerDocxMode): string | null => {
      if (file.size > serverConfig.maxUploadBytes) {
        return translated('pdfToWord.errors.fileLimit', 'PDF to Word currently supports a maximum of 50 MB per file on this server.');
      }
      const profile = profiles.get(file);
      const maxPages = mode === 'ocr' ? serverConfig.ocrMaxPages : mode === 'visual' ? serverConfig.visualMaxPages : serverConfig.nativeMaxPages;
      if (profile && profile.pageCount > maxPages) {
        return translated('pdfToWord.errors.pageLimit', `This conversion mode supports up to ${maxPages} pages per PDF.`, { limit: maxPages });
      }
      return null;
    };

    const fetchSlot = async (slotId: string): Promise<UploadSlot> => {
      const response = await fetch(`/api/docx/upload-slots/${slotId}`, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = await response.json() as { data?: { slot?: UploadSlot } };
      if (!payload.data?.slot) throw new Error('Upload reservation is unavailable');
      return payload.data.slot;
    };

    const uploadServerFile = async (file: File, mode: ServerDocxMode): Promise<string> => {
      const slotResponse = await fetch('/api/docx/upload-slots', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, inputBytes: file.size }),
      });
      if (!slotResponse.ok) throw new Error(await readApiError(slotResponse));
      const slotPayload = await slotResponse.json() as { data?: { slot?: UploadSlot } };
      let slot = slotPayload.data?.slot;
      if (!slot) throw new Error('Upload reservation is unavailable');
      activeSlotId = slot.id;
      if (slot.status === 'processing' && slot.jobId) return slot.jobId;

      const uploadOnce = (current: UploadSlot): Promise<string> => new Promise((resolve, reject) => {
        const upload = new TusUpload(file, {
          endpoint: '/api/docx/uploads',
          uploadUrl: current.status === 'uploading' ? `/api/docx/uploads/${current.id}` : null,
          chunkSize: serverConfig.uploadChunkBytes,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          parallelUploads: 1,
          storeFingerprintForResuming: false,
          removeFingerprintOnSuccess: true,
          metadata: { slotId: current.id, mode, filename: file.name, filetype: 'application/pdf' },
          onProgress: (sent, total) => {
            if (!cancelRequested && total > 0) setServerStatus(translated('pdfToWord.status.uploading', `Uploading ${formatBytes(sent)} of ${formatBytes(total)}.`, { sent: formatBytes(sent), total: formatBytes(total) }), (sent / total) * 100, true);
          },
          onSuccess: ({ lastResponse }) => {
            activeUpload = null;
            resolve(lastResponse.getHeader('Upload-Job-Id') || current.id);
          },
          onError: (error) => { activeUpload = null; reject(error); },
        });
        activeUpload = upload;
        upload.start();
      });

      for (let attempt = 0; attempt < 2; attempt++) {
        if (cancelRequested) throw new Error('CANCELLED');
        try { return await uploadOnce(slot); }
        catch (error) {
          if (cancelRequested) throw error;
          slot = await fetchSlot(slot.id);
          if (slot.status === 'processing' && slot.jobId) return slot.jobId;
        }
      }
      throw new Error('UPLOAD_INTERRUPTED');
    };

    const stageMessage = (job: ServerJob, queuePosition: number | null): string => {
      if (job.status === 'queued') return queuePosition && queuePosition > 1
        ? translated('pdfToWord.status.queue', `Waiting in the server queue. Position ${queuePosition}.`, { position: queuePosition })
        : translated('pdfToWord.status.queued', 'Waiting for the server worker.');
      const page = job.currentPage && job.totalPages ? ` ${job.currentPage}/${job.totalPages}` : '';
      const base: Record<string, string> = {
        validating: translated('pdfToWord.status.validating', 'Validating PDF...'),
        analyzing: translated('pdfToWord.status.analyzing', 'Analyzing document...'),
        repairing: translated('pdfToWord.status.repairing', 'Repairing PDF structure...'),
        converting: translated('pdfToWord.status.converting', 'Reconstructing editable DOCX...'),
        ocr: translated('pdfToWord.status.ocr', 'Recognizing text with OCR...'),
        rendering: translated('pdfToWord.status.rendering', 'Rendering pages into DOCX...'),
        packaging: translated('pdfToWord.status.packaging', 'Packaging DOCX...'),
      };
      return `${base[job.stage] || translated('pdfToWord.status.processing', 'Processing on the server...')}${page}`;
    };

    const downloadServerResult = async (jobId: string, file: File) => {
      const response = await fetch(`/api/docx/jobs/${jobId}/download`, { credentials: 'include' });
      if (!response.ok) throw new Error(await readApiError(response));
      downloadFile(await response.blob(), file.name.replace(/\.pdf$/i, '') + '.docx');
    };

    const runServerConversion = async (file: File, mode: ServerDocxMode) => {
      if (!serverConfig.enabled) throw new Error('DOCX_UNAVAILABLE');
      const issue = validateForMode(file, mode);
      if (issue) throw new Error(issue);
      hideLoader();
      cancelRequested = false;
      setServerStatus(translated('pdfToWord.status.preparing', 'Preparing secure server upload...'), 0, true);
      const jobId = await uploadServerFile(file, mode);
      activeSlotId = null;
      activeJobId = jobId;
      while (!cancelRequested) {
        const response = await fetch(`/api/docx/jobs/${jobId}`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(await readApiError(response));
        const payload = await response.json() as { data?: { job?: ServerJob; queuePosition?: number | null } };
        const job = payload.data?.job;
        if (!job) throw new Error('Job status is unavailable');
        if (job.status === 'completed') {
          setServerStatus(translated('pdfToWord.status.downloading', 'Preparing secure download...'), 100, false);
          await downloadServerResult(jobId, file);
          clearServerStatus();
          activeJobId = null;
          showAlert(translated('pdfToWord.completeTitle', 'Conversion complete'), translated('pdfToWord.completeServer', 'DOCX downloaded. Temporary server files were removed.'), 'success', resetState);
          return;
        }
        if (job.status === 'failed') throw new Error(friendlyServerError(job.errorCode));
        if (job.status === 'cancelled') throw new Error('CANCELLED');
        setServerStatus(stageMessage(job, payload.data?.queuePosition ?? null), job.progress, true);
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      throw new Error('CANCELLED');
    };

    const runClientConversion = async (files: File[]) => {
      showLoader(translated('pdfToWord.status.loading', 'Loading PDF converter...'));
      const pymupdf = await loadPyMuPDF();
      hideLoader();
      state.files = await batchDecryptIfNeeded(files);
      if (state.files.length === 1) {
        const file = state.files[0];
        showLoader(translated('pdfToWord.status.clientConverting', `Converting ${file.name}...`, { name: file.name }));
        const docx = await pymupdf.pdfToDocx(file);
        downloadFile(docx, file.name.replace(/\.pdf$/i, '') + '.docx');
      } else {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        const usedNames = new Set<string>();
        for (let index = 0; index < state.files.length; index++) {
          const file = state.files[index];
          showLoader(translated('pdfToWord.status.clientBatch', `Converting ${index + 1}/${state.files.length}: ${file.name}...`, { index: index + 1, total: state.files.length, name: file.name }));
          const docx = await pymupdf.pdfToDocx(file);
          zip.file(deduplicateFileName(file.name.replace(/\.pdf$/i, '.docx'), usedNames), await docx.arrayBuffer());
        }
        downloadFile(await zip.generateAsync({ type: 'blob' }), 'converted-documents.zip');
      }
      hideLoader();
      showAlert(translated('pdfToWord.completeTitle', 'Conversion complete'), translated('pdfToWord.completeClient', 'Review the DOCX for fonts, tables, spacing, and complex layout.'), 'success', resetState);
    };

    const convert = async () => {
      if (state.files.length === 0) { showAlert('No files', 'Please select at least one PDF file.'); return; }
      const first = state.files[0];
      const mode = resolvedMode(first);
      const issue = validateForMode(first, mode);
      if (issue) { showAlert(translated('pdfToWord.limitTitle', 'Conversion limit'), issue, 'warning'); return; }
      try {
        const profile = profiles.get(first);
        const shouldUseServer = mode !== 'editable' || first.size > serverConfig.clientMaxBytes || profile?.kind !== 'native';
        if (shouldUseServer) {
          if (state.files.length !== 1) throw new Error(translated('pdfToWord.errors.serverOneFile', 'Server conversion processes one PDF at a time. Convert large, OCR, or visual PDFs separately.'));
          await runServerConversion(first, mode);
          return;
        }
        await runClientConversion(state.files);
      } catch (error) {
        hideLoader();
        if (cancelRequested || (error instanceof Error && error.message === 'CANCELLED')) {
          clearServerStatus();
          showAlert(translated('pdfToWord.cancelledTitle', 'Conversion cancelled'), translated('pdfToWord.errors.cancelled', 'The conversion was cancelled.'), 'info');
          return;
        }
        if (state.files.length === 1 && serverConfig.enabled && knownStructureError(error)) {
          try {
            await runServerConversion(first, 'editable');
            return;
          } catch (fallbackError) {
            hideLoader();
            clearServerStatus();
            showAlert(translated('pdfToWord.errorTitle', 'Conversion failed'), knownStructureError(fallbackError)
              ? friendlyServerError('INVALID_PDF_STRUCTURE')
              : friendlyServerError(null));
            return;
          }
        }
        clearServerStatus();
        const message = error instanceof Error && error.message === 'UPLOAD_INTERRUPTED'
          ? translated('pdfToWord.errors.uploadInterrupted', 'The upload connection was interrupted. Please retry once. If it continues, contact the administrator and include the time of the attempt.')
          : error instanceof Error && error.message === 'DOCX_UNAVAILABLE'
            ? translated('pdfToWord.errors.serverUnavailable', 'Server conversion is unavailable. Try a small native-text PDF in the browser or contact the administrator.')
            : knownStructureError(error)
              ? friendlyServerError('INVALID_PDF_STRUCTURE')
              : translated('pdfToWord.errors.client', 'Your browser could not convert this PDF. Try OCR text or visual layout mode.');
        showAlert(translated('pdfToWord.errorTitle', 'Conversion failed'), message);
      }
    };

    const selectFiles = (incoming: FileList | null) => {
      if (!incoming?.length) return;
      const accepted = Array.from(incoming).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
      const tooLarge = accepted.find((file) => file.size > serverConfig.maxUploadBytes);
      if (tooLarge) {
        showAlert(translated('pdfToWord.limitTitle', 'Conversion limit'), translated('pdfToWord.errors.fileLimit', `PDF to Word currently supports a maximum of ${formatBytes(serverConfig.maxUploadBytes)} per file on this server.`, { file: tooLarge.name, limit: formatBytes(serverConfig.maxUploadBytes) }));
        return;
      }
      state.files = [...state.files, ...accepted];
      void updateUi();
    };

    fileInput?.addEventListener('change', (event) => selectFiles((event.target as HTMLInputElement).files));
    fileInput?.addEventListener('click', () => { fileInput.value = ''; });
    dropZone?.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('bg-surface-muted'); });
    dropZone?.addEventListener('dragleave', (event) => { event.preventDefault(); dropZone.classList.remove('bg-surface-muted'); });
    dropZone?.addEventListener('drop', (event) => { event.preventDefault(); dropZone.classList.remove('bg-surface-muted'); selectFiles(event.dataTransfer?.files || null); });
    addMoreButton?.addEventListener('click', () => fileInput?.click());
    clearFilesButton?.addEventListener('click', resetState);
    modeSelect.addEventListener('change', updateModeCopy);
    processButton?.addEventListener('click', () => void convert());
    backButton?.addEventListener('click', () => { window.location.href = import.meta.env.BASE_URL; });
    cancelServerButton?.addEventListener('click', async () => {
      cancelRequested = true;
      cancelServerButton.disabled = true;
      try {
        if (activeJobId) await fetch(`/api/docx/jobs/${activeJobId}`, { method: 'DELETE', credentials: 'include' });
        else if (activeSlotId) {
          await activeUpload?.abort(true).catch((): undefined => undefined);
          await fetch(`/api/docx/upload-slots/${activeSlotId}`, { method: 'DELETE', credentials: 'include' });
        }
        setServerStatus(translated('pdfToWord.status.cancelling', 'Cancelling and removing temporary files...'), null, false);
      } finally {
        cancelServerButton.disabled = false;
      }
    });

    await fetchConfig();
    updateModeCopy();
  })();
});
