import { Upload as TusUpload } from 'tus-js-client';
import { categories } from '../config/tools.js';
import { formatBytes } from '../utils/helpers-light.js';
import { initRichTextEditor } from './richTextEditor.js';

type ComplaintCategory = 'main_feature' | 'other_feature' | 'non_feature';

interface AttachmentPolicy {
  maxFiles: number;
  maxBytesPerFile: number;
  acceptedExtensions: string[];
}

interface MainFeature {
  id: string;
  name: string;
  maxBytesPerFile: number;
}

interface ComplaintConfig {
  mainFeatures: MainFeature[];
  attachmentRetentionHours: number;
  otherFeature: AttachmentPolicy;
  nonFeature: AttachmentPolicy;
  uploadChunkBytes: number;
}

interface Ticket {
  id: string;
  ticketNumber: string;
}

interface UploadSlot {
  id: string;
  status: 'ready' | 'uploading' | 'completed';
}

const MIB = 1024 * 1024;
const fallbackConfig: ComplaintConfig = {
  mainFeatures: [
    { id: 'compress-pdf', name: 'Compress PDF', maxBytesPerFile: 1024 * MIB },
    { id: 'pdf-to-docx', name: 'PDF to DOCX', maxBytesPerFile: 500 * MIB },
    { id: 'edit-pdf', name: 'Text Editor PDF', maxBytesPerFile: 500 * MIB },
  ],
  attachmentRetentionHours: 48,
  otherFeature: {
    maxFiles: 10,
    maxBytesPerFile: 10 * MIB,
    acceptedExtensions: ['.pdf'],
  },
  nonFeature: {
    maxFiles: 10,
    maxBytesPerFile: 10 * MIB,
    acceptedExtensions: [
      '.pdf',
      '.docx',
      '.xlsx',
      '.pptx',
      '.txt',
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.mp4',
    ],
  },
  uploadChunkBytes: 25 * MIB,
};

const form = document.getElementById('complaint-form') as HTMLFormElement | null;
const categorySelect = document.getElementById('complaint-category') as HTMLSelectElement | null;
const mainFeatureGroup = document.getElementById('main-feature-group');
const mainFeatureSelect = document.getElementById('main-feature') as HTMLSelectElement | null;
const otherFeatureGroup = document.getElementById('other-feature-group');
const otherFeatureSearch = document.getElementById('other-feature-search') as HTMLInputElement | null;
const otherFeatureResults = document.getElementById('other-feature-results');
const selectedOtherFeature = document.getElementById('selected-other-feature');
const attachmentInput = document.getElementById('complaint-attachments') as HTMLInputElement | null;
const attachmentGroup = document.getElementById('complaint-attachment-group');
const attachmentInfo = document.getElementById('complaint-attachment-info');
const attachmentList = document.getElementById('complaint-attachment-list');
const formStatus = document.getElementById('complaint-form-status');
const submitButton = document.getElementById('submit-complaint') as HTMLButtonElement | null;
const uploadProgress = document.getElementById('complaint-upload-progress') as HTMLProgressElement | null;
const uploadProgressLabel = document.getElementById('complaint-upload-progress-label');
const successModal = document.getElementById('complaint-success-modal');
const ticketNumber = document.getElementById('complaint-ticket-number');
const homeButton = document.getElementById('complaint-home-button') as HTMLButtonElement | null;
const subjectInput = document.getElementById('complaint-subject') as HTMLInputElement | null;
const editor = document.getElementById('complaint-editor');
const editorToolbar = document.getElementById('complaint-editor-toolbar');
const editorCount = document.getElementById('complaint-editor-count');

let config = fallbackConfig;
let selectedOtherTool: { id: string; name: string } | null = null;
let selectedFiles: File[] = [];
let draft: Ticket | null = null;
let uploadedFileKeys = new Set<string>();
let submitting = false;
let redirectTimer: number | null = null;

const toolOptions = Array.from(
  new Map(
    categories
      .flatMap((category) => category.tools)
      .map((tool) => [tool.id, { id: tool.id, name: tool.name }])
  ).values()
).sort((left, right) => left.name.localeCompare(right.name, 'id'));

const richEditor =
  editor && editorToolbar && editorCount
    ? initRichTextEditor({
        editor,
        toolbar: editorToolbar,
        count: editorCount,
        minimumCharacters: 250,
      })
    : null;

function activeCategory(): ComplaintCategory {
  return (categorySelect?.value || 'main_feature') as ComplaintCategory;
}

function currentPolicy(): AttachmentPolicy {
  const category = activeCategory();
  if (category === 'main_feature') {
    const feature = config.mainFeatures.find(
      (item) => item.id === mainFeatureSelect?.value
    );
    return {
      maxFiles: 10,
      maxBytesPerFile: feature?.maxBytesPerFile || 500 * MIB,
      acceptedExtensions: ['.pdf'],
    };
  }
  return category === 'other_feature' ? config.otherFeature : config.nonFeature;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function setStatus(message: string, type: 'info' | 'error' | 'success' = 'info'): void {
  if (!formStatus) return;
  formStatus.textContent = message;
  formStatus.className =
    type === 'error'
      ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'
      : type === 'success'
        ? 'rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'
        : 'rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800';
}

function clearStatus(): void {
  if (!formStatus) return;
  formStatus.textContent = '';
  formStatus.className = 'hidden';
}

function resetDraft(): void {
  if (submitting) return;
  draft = null;
  uploadedFileKeys = new Set<string>();
}

function renderAttachmentList(): void {
  if (!attachmentList) return;
  attachmentList.textContent = '';
  selectedFiles.forEach((file) => {
    const row = document.createElement('li');
    row.className = 'flex items-center justify-between gap-3 rounded border border-outline-variant bg-surface-gray px-3 py-2 text-sm';
    const label = document.createElement('span');
    label.className = 'min-w-0 truncate text-ink-slate dark:text-content';
    label.textContent = `${file.name} (${formatBytes(file.size)})`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'shrink-0 text-red-700 hover:underline dark:text-red-300';
    remove.textContent = 'Hapus';
    remove.addEventListener('click', () => {
      selectedFiles = selectedFiles.filter((candidate) => candidate !== file);
      resetDraft();
      renderAttachmentList();
    });
    row.append(label, remove);
    attachmentList.appendChild(row);
  });
}

function updateAttachmentControls(): void {
  const category = activeCategory();
  const policy = currentPolicy();
  const isFeatureRelated = category !== 'non_feature';
  if (mainFeatureGroup) mainFeatureGroup.classList.toggle('hidden', category !== 'main_feature');
  if (otherFeatureGroup) otherFeatureGroup.classList.toggle('hidden', category !== 'other_feature');
  if (attachmentGroup) attachmentGroup.classList.remove('hidden');
  if (attachmentInput) {
    attachmentInput.accept = isFeatureRelated
      ? '.pdf,application/pdf'
      : '.pdf,.docx,.xlsx,.pptx,.txt,.jpg,.jpeg,.png,.webp,.mp4,application/pdf,image/jpeg,image/png,image/webp,video/mp4,text/plain';
  }
  if (attachmentInfo) {
    const types = isFeatureRelated
      ? 'Hanya PDF; server memeriksa ekstensi dan signature isi file.'
      : 'PDF, DOCX, XLSX, PPTX, TXT, JPG, PNG, WebP, atau MP4; server memeriksa signature isi file.';
    attachmentInfo.textContent = `${types} Maksimal ${policy.maxFiles} file, ${formatBytes(policy.maxBytesPerFile)} per file. Lampiran dihapus otomatis paling lambat ${config.attachmentRetentionHours} jam.`;
  }
  const previousFiles = selectedFiles;
  selectedFiles = selectedFiles.filter(
    (file) =>
      policy.acceptedExtensions.includes(extensionOf(file.name)) &&
      file.size <= policy.maxBytesPerFile
  );
  if (previousFiles.length !== selectedFiles.length) {
    setStatus('Lampiran yang tidak sesuai aturan kategori telah dihapus dari daftar.', 'info');
    resetDraft();
  }
  renderAttachmentList();
}

function populateMainFeatures(): void {
  if (!mainFeatureSelect) return;
  mainFeatureSelect.textContent = '';
  config.mainFeatures.forEach((feature) => {
    const option = document.createElement('option');
    option.value = feature.id;
    option.textContent = `${feature.name} — maksimal ${formatBytes(feature.maxBytesPerFile)}/file`;
    mainFeatureSelect.appendChild(option);
  });
}

function renderOtherFeatureResults(query: string): void {
  if (!otherFeatureResults) return;
  const normalized = query.trim().toLocaleLowerCase('id');
  const matches = toolOptions
    .filter((tool) => !normalized || tool.name.toLocaleLowerCase('id').includes(normalized))
    .slice(0, 14);
  otherFeatureResults.textContent = '';
  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'px-3 py-2 text-sm text-on-surface-variant';
    empty.textContent = 'Fitur tidak ditemukan.';
    otherFeatureResults.appendChild(empty);
    return;
  }
  matches.forEach((tool) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'block w-full px-3 py-2 text-left text-sm hover:bg-orange-50 dark:hover:bg-white/5';
    option.textContent = tool.name;
    option.addEventListener('click', () => {
      selectedOtherTool = tool;
      if (otherFeatureSearch) otherFeatureSearch.value = tool.name;
      if (selectedOtherFeature) selectedOtherFeature.textContent = `Dipilih: ${tool.name}`;
      otherFeatureResults.classList.add('hidden');
      resetDraft();
    });
    otherFeatureResults.appendChild(option);
  });
  otherFeatureResults.classList.remove('hidden');
}

function addFiles(files: FileList | null): void {
  if (!files) return;
  const policy = currentPolicy();
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    if (!policy.acceptedExtensions.includes(extensionOf(file.name))) {
      errors.push(`${file.name}: format tidak diizinkan`);
      continue;
    }
    if (file.size > policy.maxBytesPerFile) {
      errors.push(`${file.name}: melebihi ${formatBytes(policy.maxBytesPerFile)}`);
      continue;
    }
    if (selectedFiles.some((item) => fileKey(item) === fileKey(file))) continue;
    if (selectedFiles.length >= policy.maxFiles) {
      errors.push(`Maksimal ${policy.maxFiles} lampiran`);
      break;
    }
    selectedFiles.push(file);
  }
  if (errors.length > 0) setStatus(errors.join(' · '), 'error');
  else clearStatus();
  resetDraft();
  renderAttachmentList();
  if (attachmentInput) attachmentInput.value = '';
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `Permintaan gagal (${response.status})`;
  } catch {
    return `Permintaan gagal (${response.status})`;
  }
}

async function fetchUploadSlot(ticketId: string, slotId: string): Promise<UploadSlot> {
  const response = await fetch(
    `/api/complaints/${encodeURIComponent(ticketId)}/upload-slots/${encodeURIComponent(slotId)}`,
    { credentials: 'include', cache: 'no-store' }
  );
  if (!response.ok) throw new Error(await readApiError(response));
  const payload = (await response.json()) as { data?: { slot?: UploadSlot } };
  if (!payload.data?.slot) throw new Error('Slot upload tidak tersedia');
  return payload.data.slot;
}

async function uploadAttachment(file: File, ticket: Ticket, index: number): Promise<void> {
  const slotResponse = await fetch(
    `/api/complaints/${encodeURIComponent(ticket.id)}/upload-slots`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, inputBytes: file.size }),
    }
  );
  if (!slotResponse.ok) throw new Error(await readApiError(slotResponse));
  const slotPayload = (await slotResponse.json()) as { data?: { slot?: UploadSlot } };
  let slot = slotPayload.data?.slot;
  if (!slot) throw new Error('Slot upload tidak tersedia');

  const uploadOnce = (current: UploadSlot): Promise<void> =>
    new Promise((resolve, reject) => {
      const upload = new TusUpload(file, {
        endpoint: '/api/complaints/uploads',
        uploadUrl:
          current.status === 'uploading'
            ? `/api/complaints/uploads/${encodeURIComponent(current.id)}`
            : null,
        chunkSize: config.uploadChunkBytes,
        retryDelays: [0, 1000, 3000, 5000, 10_000],
        parallelUploads: 1,
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: true,
        metadata: { slotId: current.id, filename: file.name },
        onProgress: (sent, total) => {
          if (uploadProgress && total > 0) uploadProgress.value = (sent / total) * 100;
          if (uploadProgressLabel) {
            uploadProgressLabel.textContent = `Mengunggah ${index + 1}/${selectedFiles.length}: ${file.name} (${formatBytes(sent)} dari ${formatBytes(total)})`;
          }
        },
        onSuccess: () => resolve(),
        onError: (error) => reject(error),
      });
      upload.start();
    });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (slot.status === 'completed') return;
    try {
      await uploadOnce(slot);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      slot = await fetchUploadSlot(ticket.id, slot.id);
    }
  }
}

function selectedFeature(): { id: string | null; name: string | null } {
  const category = activeCategory();
  if (category === 'main_feature') {
    const feature = config.mainFeatures.find((item) => item.id === mainFeatureSelect?.value);
    return { id: feature?.id || null, name: feature?.name || null };
  }
  if (category === 'other_feature') {
    return { id: selectedOtherTool?.id || null, name: selectedOtherTool?.name || null };
  }
  return { id: null, name: null };
}

function showSuccess(ticket: Ticket): void {
  if (ticketNumber) ticketNumber.textContent = ticket.ticketNumber;
  successModal?.classList.remove('hidden');
  redirectTimer = window.setTimeout(() => {
    window.location.assign('/index.html');
  }, 5000);
}

async function submitComplaint(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  clearStatus();
  if (!richEditor || !subjectInput || !submitButton) return;
  if (richEditor.getCharacterCount() < 250) {
    setStatus('Isi aduan minimal 250 karakter.', 'error');
    richEditor.focus();
    return;
  }
  const feature = selectedFeature();
  if (activeCategory() !== 'non_feature' && !feature.id) {
    setStatus('Pilih fitur yang terkait dengan aduan ini.', 'error');
    return;
  }
  const policy = currentPolicy();
  if (selectedFiles.length > policy.maxFiles) {
    setStatus(`Maksimal ${policy.maxFiles} lampiran untuk kategori ini.`, 'error');
    return;
  }

  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Mengirim aduan…';
  try {
    if (!draft) {
      const createResponse = await fetch('/api/complaints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: activeCategory(),
          featureId: feature.id,
          featureName: feature.name,
          subject: subjectInput.value.trim(),
          contentHtml: richEditor.getHtml(),
        }),
      });
      if (!createResponse.ok) throw new Error(await readApiError(createResponse));
      const payload = (await createResponse.json()) as { data?: { ticket?: Ticket } };
      if (!payload.data?.ticket) throw new Error('Tiket aduan tidak dapat dibuat');
      draft = payload.data.ticket;
    }

    for (const [index, file] of selectedFiles.entries()) {
      if (uploadedFileKeys.has(fileKey(file))) continue;
      if (uploadProgress) uploadProgress.classList.remove('hidden');
      await uploadAttachment(file, draft, index);
      uploadedFileKeys.add(fileKey(file));
    }
    if (uploadProgress) uploadProgress.classList.add('hidden');
    if (uploadProgressLabel) uploadProgressLabel.textContent = '';

    const submitResponse = await fetch(
      `/api/complaints/${encodeURIComponent(draft.id)}/submit`,
      { method: 'POST', credentials: 'include' }
    );
    if (!submitResponse.ok) throw new Error(await readApiError(submitResponse));
    const payload = (await submitResponse.json()) as { data?: { ticket?: Ticket } };
    if (!payload.data?.ticket) throw new Error('Aduan tidak dapat dikirim');
    showSuccess(payload.data.ticket);
  } catch (error) {
    if (uploadProgress) uploadProgress.classList.add('hidden');
    setStatus(
      error instanceof Error ? error.message : 'Aduan belum dapat dikirim. Coba lagi.',
      'error'
    );
  } finally {
    submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Kirim Aduan';
  }
}

async function loadConfig(): Promise<void> {
  try {
    const response = await fetch('/api/complaints/config', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: Partial<ComplaintConfig> };
    config = { ...fallbackConfig, ...payload.data };
  } catch {
    // The fallback precisely mirrors the server defaults and keeps client-side
    // guidance available even if this optional config request is unavailable.
  }
}

async function init(): Promise<void> {
  if (!form || !categorySelect || !attachmentInput || !mainFeatureSelect) return;
  await loadConfig();
  populateMainFeatures();
  updateAttachmentControls();
  renderOtherFeatureResults('');
  otherFeatureResults?.classList.add('hidden');

  categorySelect.addEventListener('change', () => {
    selectedOtherTool = null;
    if (otherFeatureSearch) otherFeatureSearch.value = '';
    if (selectedOtherFeature) selectedOtherFeature.textContent = '';
    resetDraft();
    updateAttachmentControls();
  });
  mainFeatureSelect.addEventListener('change', () => {
    resetDraft();
    updateAttachmentControls();
  });
  otherFeatureSearch?.addEventListener('focus', () =>
    renderOtherFeatureResults(otherFeatureSearch.value)
  );
  otherFeatureSearch?.addEventListener('input', () => {
    selectedOtherTool = null;
    if (selectedOtherFeature) selectedOtherFeature.textContent = '';
    resetDraft();
    renderOtherFeatureResults(otherFeatureSearch.value);
  });
  attachmentInput.addEventListener('change', () => addFiles(attachmentInput.files));
  subjectInput?.addEventListener('input', resetDraft);
  editor?.addEventListener('input', resetDraft);
  form.addEventListener('submit', (event) => void submitComplaint(event));
  homeButton?.addEventListener('click', () => {
    if (redirectTimer) window.clearTimeout(redirectTimer);
    window.location.assign('/index.html');
  });
}

void init();
