import { Upload as TusUpload } from 'tus-js-client';
import { formatBytes } from '../utils/helpers-light.js';
import { initAuth, requireAdmin } from '../auth/guard.js';

type AssetType = 'pdf' | 'video';
interface GuideMaterial {
  id: string;
  title: string;
  description: string;
  assetType: AssetType;
  assetStatus: 'pending' | 'uploading' | 'ready';
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  position: number;
  isPublished: boolean;
}
interface UploadSlot {
  id: string;
  status: 'ready' | 'uploading' | 'completed';
}
interface ApiPayload<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const list = document.getElementById('guide-admin-list');
const statusBox = document.getElementById('admin-guide-status');
const createForm = document.getElementById('guide-create-form') as HTMLFormElement | null;
const titleInput = document.getElementById('guide-title') as HTMLInputElement | null;
const descriptionInput = document.getElementById('guide-description') as HTMLTextAreaElement | null;
const assetTypeInput = document.getElementById('guide-asset-type') as HTMLSelectElement | null;
const fileInput = document.getElementById('guide-file') as HTMLInputElement | null;
const createButton = document.getElementById('create-guide-button') as HTMLButtonElement | null;
const createProgress = document.getElementById('guide-create-progress') as HTMLProgressElement | null;
const createProgressLabel = document.getElementById('guide-create-progress-label');
const saveOrderButton = document.getElementById('save-guide-order') as HTMLButtonElement | null;

let guides: GuideMaterial[] = [];
const MAX_BYTES = 100 * 1024 * 1024;

function showStatus(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  if (!statusBox) return;
  statusBox.className =
    type === 'success'
      ? 'mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'
      : type === 'error'
        ? 'mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'
        : 'mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800';
  statusBox.textContent = message;
}

async function apiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiPayload<unknown>;
    return payload.error || `Permintaan gagal (${response.status})`;
  } catch {
    return `Permintaan gagal (${response.status})`;
  }
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

function setAssetTypeAccept(): void {
  if (!assetTypeInput || !fileInput) return;
  const video = assetTypeInput.value === 'video';
  fileInput.accept = video ? '.mp4,video/mp4' : '.pdf,application/pdf';
}

function matchesAssetType(assetType: string, filename: string): boolean {
  return assetType === 'video' ? /\.mp4$/i.test(filename) : /\.pdf$/i.test(filename);
}

function statusText(guide: GuideMaterial): string {
  if (guide.assetStatus === 'ready') return guide.isPublished ? 'Published' : 'Draft';
  return 'Belum ada file';
}

function buildGuideCard(guide: GuideMaterial, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'rounded-xl border border-outline-variant p-4';

  const header = document.createElement('div');
  header.className = 'flex flex-col gap-3 md:flex-row md:items-start md:justify-between';
  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'font-bold text-ink-slate dark:text-content';
  title.textContent = `${index + 1}. ${guide.title}`;
  const detail = document.createElement('p');
  detail.className = 'mt-1 text-xs text-on-surface-variant';
  detail.textContent = `${guide.assetType === 'pdf' ? 'PDF' : 'MP4'} · ${guide.originalFilename || 'File belum diunggah'}${guide.sizeBytes ? ` · ${formatBytes(guide.sizeBytes)}` : ''}`;
  heading.append(title, detail);

  const status = document.createElement('span');
  status.className = guide.isPublished && guide.assetStatus === 'ready'
    ? 'inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'inline-flex rounded-full bg-surface-gray px-2.5 py-1 text-xs font-semibold text-on-surface-variant';
  status.textContent = statusText(guide);
  header.append(heading, status);
  card.appendChild(header);

  const fields = document.createElement('div');
  fields.className = 'mt-4 grid gap-3 md:grid-cols-2';
  const titleField = document.createElement('input');
  titleField.value = guide.title;
  titleField.maxLength = 180;
  titleField.className = 'rounded-lg border border-outline-variant bg-background px-3 py-2 text-sm';
  titleField.setAttribute('aria-label', 'Judul materi');
  const descriptionField = document.createElement('input');
  descriptionField.value = guide.description;
  descriptionField.maxLength = 2000;
  descriptionField.className = 'rounded-lg border border-outline-variant bg-background px-3 py-2 text-sm';
  descriptionField.setAttribute('aria-label', 'Deskripsi materi');
  fields.append(titleField, descriptionField);
  card.appendChild(fields);

  const controls = document.createElement('div');
  controls.className = 'mt-4 flex flex-wrap items-center gap-2';
  const save = button('Simpan teks', 'rounded-lg bg-vibrant-palm px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600');
  save.addEventListener('click', () => void updateGuide(guide.id, {
    title: titleField.value.trim(),
    description: descriptionField.value.trim(),
  }));
  const publishLabel = document.createElement('label');
  publishLabel.className = 'inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold';
  const publish = document.createElement('input');
  publish.type = 'checkbox';
  publish.checked = guide.isPublished;
  publish.disabled = guide.assetStatus !== 'ready';
  publish.addEventListener('change', () => void updateGuide(guide.id, { isPublished: publish.checked }));
  publishLabel.append(publish, document.createTextNode('Tampilkan ke user'));

  const moveUp = button('Naik', 'rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm disabled:opacity-40');
  moveUp.disabled = index === 0;
  moveUp.addEventListener('click', () => moveGuide(index, -1));
  const moveDown = button('Turun', 'rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm disabled:opacity-40');
  moveDown.disabled = index === guides.length - 1;
  moveDown.addEventListener('click', () => moveGuide(index, 1));

  const replaceLabel = document.createElement('label');
  replaceLabel.className = 'cursor-pointer rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm';
  replaceLabel.textContent = guide.assetStatus === 'ready' ? 'Ganti file' : 'Unggah file';
  const replaceInput = document.createElement('input');
  replaceInput.type = 'file';
  replaceInput.className = 'hidden';
  replaceInput.accept = guide.assetType === 'pdf' ? '.pdf,application/pdf' : '.mp4,video/mp4';
  replaceInput.addEventListener('change', () => {
    const file = replaceInput.files?.[0];
    if (file) void uploadGuideFile(guide, file);
  });
  replaceLabel.appendChild(replaceInput);

  const remove = button('Hapus', 'rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 dark:text-red-300');
  remove.addEventListener('click', () => {
    if (window.confirm(`Hapus materi “${guide.title}”?`)) void deleteGuide(guide.id);
  });
  controls.append(save, publishLabel, moveUp, moveDown, replaceLabel, remove);
  card.appendChild(controls);
  return card;
}

function render(): void {
  if (!list) return;
  list.textContent = '';
  if (guides.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rounded-lg border border-dashed border-outline-variant p-5 text-sm text-on-surface-variant';
    empty.textContent = 'Belum ada materi Guide.';
    list.appendChild(empty);
    return;
  }
  guides.forEach((guide, index) => list.appendChild(buildGuideCard(guide, index)));
}

async function loadGuides(): Promise<void> {
  const response = await fetch('/api/admin/guides', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as ApiPayload<{ guides?: GuideMaterial[] }>;
  guides = payload.data?.guides || [];
  render();
}

async function updateGuide(id: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/admin/guides/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  showStatus('Materi berhasil diperbarui.', 'success');
  await loadGuides();
}

function moveGuide(index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (target < 0 || target >= guides.length) return;
  const [moved] = guides.splice(index, 1);
  guides.splice(target, 0, moved);
  render();
  showStatus('Urutan berubah di layar. Klik “Simpan urutan” untuk menyimpan.', 'info');
}

async function saveOrder(): Promise<void> {
  if (!saveOrderButton) return;
  saveOrderButton.disabled = true;
  const response = await fetch('/api/admin/guides/reorder', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: guides.map((guide) => guide.id) }),
  });
  saveOrderButton.disabled = false;
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    await loadGuides();
    return;
  }
  showStatus('Urutan materi berhasil disimpan.', 'success');
  await loadGuides();
}

async function deleteGuide(id: string): Promise<void> {
  const response = await fetch(`/api/admin/guides/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include',
  });
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  showStatus('Materi dan file terkait sudah dihapus.', 'success');
  await loadGuides();
}

async function getSlot(guideId: string, slotId: string): Promise<UploadSlot> {
  const response = await fetch(`/api/admin/guides/${encodeURIComponent(guideId)}/upload-slots/${encodeURIComponent(slotId)}`, {
    credentials: 'include', cache: 'no-store',
  });
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as ApiPayload<{ slot?: UploadSlot }>;
  if (!payload.data?.slot) throw new Error('Slot upload tidak tersedia');
  return payload.data.slot;
}

async function uploadGuideFile(guide: GuideMaterial, file: File): Promise<void> {
  const extensionOkay = matchesAssetType(guide.assetType, file.name);
  if (!extensionOkay) {
    showStatus(guide.assetType === 'pdf' ? 'Materi harus berupa PDF.' : 'Materi video harus berupa MP4.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    showStatus('Ukuran materi maksimal 100 MB.', 'error');
    return;
  }
  if (createProgress) createProgress.classList.remove('hidden');
  try {
    const slotResponse = await fetch(`/api/admin/guides/${encodeURIComponent(guide.id)}/upload-slots`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, inputBytes: file.size }),
    });
    if (!slotResponse.ok) throw new Error(await apiError(slotResponse));
    const slotPayload = (await slotResponse.json()) as ApiPayload<{ slot?: UploadSlot }>;
    let slot = slotPayload.data?.slot;
    if (!slot) throw new Error('Slot upload tidak tersedia');

    const uploadOnce = (current: UploadSlot): Promise<void> =>
      new Promise((resolve, reject) => {
        const upload = new TusUpload(file, {
          endpoint: '/api/guides/uploads',
          uploadUrl: current.status === 'uploading' ? `/api/guides/uploads/${encodeURIComponent(current.id)}` : null,
          chunkSize: 25 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          parallelUploads: 1,
          storeFingerprintForResuming: false,
          removeFingerprintOnSuccess: true,
          metadata: { slotId: current.id, filename: file.name },
          onProgress: (sent, total) => {
            if (createProgress && total > 0) createProgress.value = (sent / total) * 100;
            if (createProgressLabel) createProgressLabel.textContent = `Mengunggah ${file.name}: ${formatBytes(sent)} dari ${formatBytes(total)}`;
          },
          onSuccess: () => resolve(),
          onError: reject,
        });
        upload.start();
      });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await uploadOnce(slot);
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        slot = await getSlot(guide.id, slot.id);
      }
    }
    showStatus('File materi berhasil diunggah. Materi masih draft sampai dipublikasikan.', 'success');
    await loadGuides();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Upload materi gagal.', 'error');
  } finally {
    createProgress?.classList.add('hidden');
    if (createProgressLabel) createProgressLabel.textContent = '';
  }
}

async function createGuide(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!titleInput || !descriptionInput || !assetTypeInput || !fileInput || !createButton) return;
  const file = fileInput.files?.[0];
  if (!file) {
    showStatus('Pilih file materi terlebih dahulu.', 'error');
    return;
  }
  if (!matchesAssetType(assetTypeInput.value, file.name)) {
    showStatus(
      assetTypeInput.value === 'video'
        ? 'Materi video harus berupa MP4.'
        : 'Materi harus berupa PDF.',
      'error'
    );
    return;
  }
  if (file.size > MAX_BYTES) {
    showStatus('Ukuran materi maksimal 100 MB.', 'error');
    return;
  }
  createButton.disabled = true;
  try {
    const response = await fetch('/api/admin/guides', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titleInput.value.trim(), description: descriptionInput.value.trim(), assetType: assetTypeInput.value }),
    });
    if (!response.ok) throw new Error(await apiError(response));
    const payload = (await response.json()) as ApiPayload<{ guide?: GuideMaterial }>;
    if (!payload.data?.guide) throw new Error('Materi tidak dapat dibuat');
    await uploadGuideFile(payload.data.guide, file);
    createForm?.reset();
    setAssetTypeAccept();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Materi tidak dapat dibuat.', 'error');
  } finally {
    createButton.disabled = false;
  }
}

async function init(): Promise<void> {
  await initAuth();
  requireAdmin();
  assetTypeInput?.addEventListener('change', setAssetTypeAccept);
  createForm?.addEventListener('submit', (event) => void createGuide(event));
  saveOrderButton?.addEventListener('click', () => void saveOrder());
  try {
    await loadGuides();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Materi tidak dapat dimuat.', 'error');
  }
}

void init();
