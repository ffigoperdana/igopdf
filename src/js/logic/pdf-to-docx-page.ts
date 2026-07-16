import { showLoader, hideLoader, showAlert } from '../ui.js';
import { t } from '../i18n/i18n';
import {
  downloadFile,
  readFileAsArrayBuffer,
  formatBytes,
  getPDFDocument,
} from '../utils/helpers.js';
import { state } from '../state.js';
import { createIcons, icons } from 'lucide';
import { loadPyMuPDF } from '../utils/pymupdf-loader.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { deduplicateFileName } from '../utils/deduplicate-filename.js';
import {
  warnForLargeClientSideFiles,
  CLIENT_SIDE_OCR_WARNING_BYTES,
} from '../utils/client-file-warning.js';

type PdfTextLayerProfile = {
  pageCount: number;
  samplePages: number;
  imageBasedPages: number;
};

const textLayerProfiles = new WeakMap<File, PdfTextLayerProfile>();

async function inspectTextLayer(
  file: File,
  source?: ArrayBuffer
): Promise<PdfTextLayerProfile> {
  const arrayBuffer = source ?? (await readFileAsArrayBuffer(file));
  const pdfDoc = await getPDFDocument({ data: arrayBuffer }).promise;
  const pageCount = pdfDoc.numPages;
  const samplePages = Math.min(pdfDoc.numPages, 3);
  let imageBasedPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= samplePages; pageNumber++) {
      const page = await pdfDoc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textLength = textContent.items.reduce((length, item) => {
        const text = 'str' in item ? item.str : '';
        return length + text.trim().length;
      }, 0);
      if (textLength < 20) imageBasedPages += 1;
    }
  } finally {
    await pdfDoc.destroy();
  }

  return { pageCount, samplePages, imageBasedPages };
}

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const processBtn = document.getElementById('process-btn');
  const fileDisplayArea = document.getElementById('file-display-area');
  const convertOptions = document.getElementById('convert-options');
  const fileControls = document.getElementById('file-controls');
  const addMoreBtn = document.getElementById('add-more-btn');
  const clearFilesBtn = document.getElementById('clear-files-btn');
  const backBtn = document.getElementById('back-to-tools');
  const qualityNotice = document.getElementById('conversion-quality-notice');
  const qualityMessage = document.getElementById('conversion-quality-message');
  const openOcrLink = document.getElementById(
    'conversion-open-ocr'
  ) as HTMLAnchorElement | null;

  const updateQualityNotice = () => {
    if (!qualityNotice || !qualityMessage || state.files.length === 0) return;
    const profiles = state.files
      .map((file) => textLayerProfiles.get(file))
      .filter((profile): profile is PdfTextLayerProfile => Boolean(profile));

    if (profiles.length === 0) {
      qualityNotice.classList.add('hidden');
      return;
    }

    const imageBasedPages = profiles.reduce(
      (total, profile) => total + profile.imageBasedPages,
      0
    );
    const samplePages = profiles.reduce(
      (total, profile) => total + profile.samplePages,
      0
    );
    const imageBased = imageBasedPages > 0;
    qualityMessage.textContent = imageBased
      ? t('pdfToWord.imageBasedDetected', { imagePages: imageBasedPages, samplePages })
      : t('pdfToWord.nativeTextDetected');
    qualityNotice.classList.remove('hidden');

    if (openOcrLink) {
      openOcrLink.textContent = t('pdfToWord.openOcr');
      openOcrLink.classList.toggle('hidden', !imageBased);
    }
  };

  const conversionQualitySummary = (files: File[]) => {
    const hasImageBasedPage = files.some(
      (file) => (textLayerProfiles.get(file)?.imageBasedPages ?? 0) > 0
    );
    return hasImageBasedPage
      ? t('pdfToWord.postImageWarning')
      : t('pdfToWord.postNativeWarning');
  };

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.location.href = import.meta.env.BASE_URL;
    });
  }

  const updateUI = async () => {
    if (!fileDisplayArea || !convertOptions || !processBtn || !fileControls)
      return;

    if (state.files.length > 0) {
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
        metaSpan.textContent = `${formatBytes(file.size)} • ${t('common.loadingPageCount')}`;

        infoContainer.append(nameSpan, metaSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className =
          'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
        removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
        removeBtn.onclick = () => {
          state.files = state.files.filter((_: File, i: number) => i !== index);
          updateUI();
        };

        fileDiv.append(infoContainer, removeBtn);
        fileDisplayArea.appendChild(fileDiv);

        try {
          const arrayBuffer = await readFileAsArrayBuffer(file);
          const profile = await inspectTextLayer(file, arrayBuffer);
          textLayerProfiles.set(file, profile);
          const pdfDoc = { numPages: profile.pageCount };
          metaSpan.textContent = `${formatBytes(file.size)} • ${pdfDoc.numPages} pages`;
        } catch {
          metaSpan.textContent = `${formatBytes(file.size)} • Could not load page count`;
        }
      }

      updateQualityNotice();
      createIcons({ icons });
      fileControls.classList.remove('hidden');
      convertOptions.classList.remove('hidden');
      (processBtn as HTMLButtonElement).disabled = false;
    } else {
      fileDisplayArea.innerHTML = '';
      qualityNotice?.classList.add('hidden');
      fileControls.classList.add('hidden');
      convertOptions.classList.add('hidden');
      (processBtn as HTMLButtonElement).disabled = true;
    }
  };

  const resetState = () => {
    state.files = [];
    state.pdfDoc = null;
    updateUI();
  };

  const convert = async () => {
    try {
      if (state.files.length === 0) {
        showAlert('No Files', 'Please select at least one PDF file.');
        return;
      }
      const qualitySummary = conversionQualitySummary(state.files);

      showLoader('Loading PDF converter...');
      const pymupdf = await loadPyMuPDF();

      hideLoader();
      state.files = await batchDecryptIfNeeded(state.files);
      showLoader('Converting...');

      if (state.files.length === 1) {
        const file = state.files[0];
        showLoader(`Converting ${file.name}...`);

        const docxBlob = await pymupdf.pdfToDocx(file);
        const outName = file.name.replace(/\.pdf$/i, '') + '.docx';

        downloadFile(docxBlob, outName);
        hideLoader();

        showAlert(
          'Conversion Complete',
          `Successfully converted ${file.name} to DOCX. ${qualitySummary}`,
          'success',
          () => resetState()
        );
      } else {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        const usedNames = new Set<string>();

        for (let i = 0; i < state.files.length; i++) {
          const file = state.files[i];
          showLoader(
            `Converting ${i + 1}/${state.files.length}: ${file.name}...`
          );

          const docxBlob = await pymupdf.pdfToDocx(file);
          const baseName = file.name.replace(/\.pdf$/i, '');
          const arrayBuffer = await docxBlob.arrayBuffer();
          const zipEntryName = deduplicateFileName(
            `${baseName}.docx`,
            usedNames
          );
          zip.file(zipEntryName, arrayBuffer);
        }

        showLoader('Creating ZIP archive...');
        const zipBlob = await zip.generateAsync({ type: 'blob' });

        downloadFile(zipBlob, 'converted-documents.zip');
        hideLoader();

        showAlert(
          'Conversion Complete',
          `Successfully converted ${state.files.length} PDF(s) to DOCX. ${qualitySummary}`,
          'success',
          () => resetState()
        );
      }
    } catch (e: unknown) {
      hideLoader();
      showAlert(
        'Error',
        `An error occurred during conversion. Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      const pdfFiles = Array.from(files).filter(
        (f) =>
          f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      warnForLargeClientSideFiles(
        pdfFiles,
        t('clientProcessing.pdfToWord'),
        CLIENT_SIDE_OCR_WARNING_BYTES
      );
      state.files = [...state.files, ...pdfFiles];
      updateUI();
    }
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
        handleFileSelect(files);
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

  if (processBtn) {
    processBtn.addEventListener('click', convert);
  }
});
