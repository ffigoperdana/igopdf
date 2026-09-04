import { Upload as TusUpload } from 'tus-js-client';
import { formatBytes } from '../utils/helpers-light.js';
import { initAuth, requireAdmin } from '../auth/guard.js';
import { initI18n, t } from '../i18n/index.js';

type AssetType = 'pdf' | 'video';
type BatchItemStatus = 'queued' | 'uploading' | 'completed' | 'error';

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

interface BatchItem {
  file: File;
  title: string;
  assetType: AssetType;
  guide?: GuideMaterial;
  status: BatchItemStatus;
  error?: string;
}

interface UploadOptions {
  onProgress?: (sent: number, total: number) => void;
  refresh?: boolean;
  silent?: boolean;
}

const list = document.getElementById('guide-admin-list');
const statusBox = document.getElementById('admin-guide-status');
const createForm = document.getElementById(
  'guide-create-form'
) as HTMLFormElement | null;
const fileInput = document.getElementById(
  'guide-file'
) as HTMLInputElement | null;
const uploadQueue = document.getElementById('guide-upload-queue');
const createButton = document.getElementById(
  'create-guide-button'
) as HTMLButtonElement | null;
const createProgress = document.getElementById(
  'guide-create-progress'
) as HTMLProgressElement | null;
const createProgressLabel = document.getElementById(
  'guide-create-progress-label'
);
const saveOrderButton = document.getElementById(
  'save-guide-order'
) as HTMLButtonElement | null;

let guides: GuideMaterial[] = [];
let batchItems: BatchItem[] = [];
let batchUploading = false;
let guidesLoaded = false;
const MAX_BYTES = 100 * 1024 * 1024;

function showStatus(
  message: string,
  type: 'success' | 'error' | 'info' = 'info'
): void {
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
    return (
      payload.error ||
      t('adminGuide.messages.requestFailed', { status: response.status })
    );
  } catch {
    return t('adminGuide.messages.requestFailed', { status: response.status });
  }
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

function assetTypeFromFilename(filename: string): AssetType | null {
  if (/\.pdf$/i.test(filename)) return 'pdf';
  if (/\.mp4$/i.test(filename)) return 'video';
  return null;
}

function matchesAssetType(assetType: AssetType, filename: string): boolean {
  return assetTypeFromFilename(filename) === assetType;
}

function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || filename;
  const cleaned = basename
    .replace(/\.(pdf|mp4)$/i, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
    .trim();
  if (!cleaned) return t('adminGuide.defaults.material');
  return cleaned.length >= 3
    ? cleaned
    : `${t('adminGuide.defaults.prefix')} ${cleaned}`;
}

function statusText(guide: GuideMaterial): string {
  if (guide.assetStatus === 'ready')
    return guide.isPublished
      ? t('adminGuide.status.published')
      : t('adminGuide.status.draft');
  return t('adminGuide.status.missing');
}

function buildGuideCard(guide: GuideMaterial, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'rounded-xl border border-outline-variant p-4';

  const header = document.createElement('div');
  header.className =
    'flex flex-col gap-3 md:flex-row md:items-start md:justify-between';
  const heading = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'font-bold text-ink-slate dark:text-content';
  title.textContent = `${index + 1}. ${guide.title}`;
  const detail = document.createElement('p');
  detail.className = 'mt-1 text-xs text-on-surface-variant';
  detail.textContent = `${t(guide.assetType === 'pdf' ? 'adminGuide.type.pdf' : 'adminGuide.type.video')} · ${guide.originalFilename || t('adminGuide.fileMissing')}${guide.sizeBytes ? ` · ${formatBytes(guide.sizeBytes)}` : ''}`;
  heading.append(title, detail);

  const status = document.createElement('span');
  status.className =
    guide.isPublished && guide.assetStatus === 'ready'
      ? 'inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'inline-flex rounded-full bg-surface-gray px-2.5 py-1 text-xs font-semibold text-on-surface-variant';
  status.textContent = statusText(guide);
  header.append(heading, status);
  card.appendChild(header);

  const fields = document.createElement('div');
  fields.className = 'mt-4 grid gap-3 md:grid-cols-2';
  const titleField = document.createElement('input');
  titleField.dataset.guideTitleInput = guide.id;
  titleField.value = guide.title;
  titleField.maxLength = 180;
  titleField.className =
    'rounded-lg border border-outline-variant bg-background px-3 py-2 text-sm';
  titleField.placeholder = t('adminGuide.labels.title');
  titleField.setAttribute('aria-label', t('adminGuide.labels.title'));
  const descriptionField = document.createElement('input');
  descriptionField.dataset.guideDescriptionInput = guide.id;
  descriptionField.value = guide.description;
  descriptionField.maxLength = 2000;
  descriptionField.className =
    'rounded-lg border border-outline-variant bg-background px-3 py-2 text-sm';
  descriptionField.placeholder = t('adminGuide.labels.description');
  descriptionField.setAttribute(
    'aria-label',
    t('adminGuide.labels.description')
  );
  fields.append(titleField, descriptionField);
  card.appendChild(fields);

  const controls = document.createElement('div');
  controls.className = 'mt-4 flex flex-wrap items-center gap-2';
  const save = button(
    t('adminGuide.actions.saveText'),
    'rounded-lg bg-vibrant-palm px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600'
  );
  save.addEventListener(
    'click',
    () =>
      void updateGuide(guide.id, {
        title: titleField.value.trim(),
        description: descriptionField.value.trim(),
      })
  );
  const publishLabel = document.createElement('label');
  publishLabel.className =
    'inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold';
  const publish = document.createElement('input');
  publish.type = 'checkbox';
  publish.checked = guide.isPublished;
  publish.disabled = guide.assetStatus !== 'ready';
  publish.addEventListener(
    'change',
    () => void updateGuide(guide.id, { isPublished: publish.checked })
  );
  publishLabel.append(
    publish,
    document.createTextNode(t('adminGuide.actions.showToUsers'))
  );

  const moveUp = button(
    t('adminGuide.actions.up'),
    'rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm disabled:opacity-40'
  );
  moveUp.disabled = index === 0;
  moveUp.addEventListener('click', () => moveGuide(index, -1));
  const moveDown = button(
    t('adminGuide.actions.down'),
    'rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm disabled:opacity-40'
  );
  moveDown.disabled = index === guides.length - 1;
  moveDown.addEventListener('click', () => moveGuide(index, 1));

  const replaceLabel = document.createElement('label');
  replaceLabel.className =
    'cursor-pointer rounded-lg border border-outline-variant px-3 py-2 text-xs font-semibold hover:border-vibrant-palm';
  replaceLabel.textContent =
    guide.assetStatus === 'ready'
      ? t('adminGuide.actions.replace')
      : t('adminGuide.actions.upload');
  const replaceInput = document.createElement('input');
  replaceInput.type = 'file';
  replaceInput.className = 'hidden';
  replaceInput.accept =
    guide.assetType === 'pdf' ? '.pdf,application/pdf' : '.mp4,video/mp4';
  replaceInput.addEventListener('change', () => {
    const file = replaceInput.files?.[0];
    if (file)
      void uploadGuideFile(guide, file).catch((): undefined => undefined);
  });
  replaceLabel.appendChild(replaceInput);

  const remove = button(
    t('adminGuide.actions.delete'),
    'rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 dark:text-red-300'
  );
  remove.addEventListener('click', () => {
    if (window.confirm(t('adminGuide.confirmDelete', { title: guide.title })))
      void deleteGuide(guide.id);
  });
  controls.append(save, publishLabel, moveUp, moveDown, replaceLabel, remove);
  card.appendChild(controls);
  return card;
}

function render(preserveDrafts = false): void {
  if (!list) return;
  const drafts = new Map<string, { title: string; description: string }>();
  if (preserveDrafts) {
    const descriptionFields = Array.from(
      list.querySelectorAll<HTMLInputElement>('[data-guide-description-input]')
    );
    list
      .querySelectorAll<HTMLInputElement>('[data-guide-title-input]')
      .forEach((field) => {
        const id = field.dataset.guideTitleInput;
        if (!id) return;
        const descriptionField = descriptionFields.find(
          (candidate) => candidate.dataset.guideDescriptionInput === id
        );
        drafts.set(id, {
          title: field.value,
          description: descriptionField?.value || '',
        });
      });
  }
  list.textContent = '';
  if (guides.length === 0) {
    const empty = document.createElement('p');
    empty.className =
      'rounded-lg border border-dashed border-outline-variant p-5 text-sm text-on-surface-variant';
    empty.textContent = t('adminGuide.empty');
    list.appendChild(empty);
    return;
  }
  guides.forEach((guide, index) => {
    const card = buildGuideCard(guide, index);
    const draft = drafts.get(guide.id);
    if (draft) {
      const titleField = card.querySelector<HTMLInputElement>(
        '[data-guide-title-input]'
      );
      const descriptionField = card.querySelector<HTMLInputElement>(
        '[data-guide-description-input]'
      );
      if (titleField) titleField.value = draft.title;
      if (descriptionField) descriptionField.value = draft.description;
    }
    list.appendChild(card);
  });
}

async function loadGuides(): Promise<void> {
  const response = await fetch('/api/admin/guides', {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as ApiPayload<{
    guides?: GuideMaterial[];
  }>;
  guides = payload.data?.guides || [];
  guidesLoaded = true;
  render();
}

async function updateGuide(
  id: string,
  body: Record<string, unknown>
): Promise<void> {
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
  showStatus(t('adminGuide.messages.updated'), 'success');
  await loadGuides();
}

function moveGuide(index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (target < 0 || target >= guides.length) return;
  const [moved] = guides.splice(index, 1);
  guides.splice(target, 0, moved);
  render();
  showStatus(t('adminGuide.messages.orderChanged'), 'info');
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
  showStatus(t('adminGuide.messages.orderSaved'), 'success');
  await loadGuides();
}

async function deleteGuide(id: string): Promise<void> {
  const response = await fetch(`/api/admin/guides/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  showStatus(t('adminGuide.messages.deleted'), 'success');
  await loadGuides();
}

async function getSlot(guideId: string, slotId: string): Promise<UploadSlot> {
  const response = await fetch(
    `/api/admin/guides/${encodeURIComponent(guideId)}/upload-slots/${encodeURIComponent(slotId)}`,
    {
      credentials: 'include',
      cache: 'no-store',
    }
  );
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as ApiPayload<{ slot?: UploadSlot }>;
  if (!payload.data?.slot)
    throw new Error(t('adminGuide.messages.slotUnavailable'));
  return payload.data.slot;
}

async function uploadGuideFile(
  guide: GuideMaterial,
  file: File,
  options: UploadOptions = {}
): Promise<void> {
  const extensionOkay = matchesAssetType(guide.assetType, file.name);
  const errorMessage = extensionOkay
    ? file.size > MAX_BYTES
      ? t('adminGuide.messages.fileTooLarge')
      : file.size <= 0
        ? t('adminGuide.messages.emptyFile')
        : null
    : guide.assetType === 'pdf'
      ? t('adminGuide.messages.mustBePdf')
      : t('adminGuide.messages.mustBeMp4');
  if (errorMessage) {
    if (options.silent !== true) showStatus(errorMessage, 'error');
    throw new Error(errorMessage);
  }

  const quiet = options.silent === true;
  const usesExternalProgress = typeof options.onProgress === 'function';
  if (!usesExternalProgress) createProgress?.classList.remove('hidden');
  try {
    const slotResponse = await fetch(
      `/api/admin/guides/${encodeURIComponent(guide.id)}/upload-slots`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, inputBytes: file.size }),
      }
    );
    if (!slotResponse.ok) throw new Error(await apiError(slotResponse));
    const slotPayload = (await slotResponse.json()) as ApiPayload<{
      slot?: UploadSlot;
    }>;
    let slot = slotPayload.data?.slot;
    if (!slot) throw new Error(t('adminGuide.messages.slotUnavailable'));

    const uploadOnce = (current: UploadSlot): Promise<void> =>
      new Promise((resolve, reject) => {
        const upload = new TusUpload(file, {
          endpoint: '/api/guides/uploads',
          uploadUrl:
            current.status === 'uploading'
              ? `/api/guides/uploads/${encodeURIComponent(current.id)}`
              : null,
          chunkSize: 25 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          parallelUploads: 1,
          storeFingerprintForResuming: false,
          removeFingerprintOnSuccess: true,
          metadata: { slotId: current.id, filename: file.name },
          onProgress: (sent, total) => {
            if (options.onProgress) {
              options.onProgress(sent, total);
            } else {
              if (createProgress && total > 0)
                createProgress.value = (sent / total) * 100;
              if (createProgressLabel)
                createProgressLabel.textContent = t(
                  'adminGuide.messages.batchUploading',
                  {
                    name: file.name,
                    sent: formatBytes(sent),
                    total: formatBytes(total),
                  }
                );
            }
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
    if (!quiet) showStatus(t('adminGuide.messages.uploadSuccess'), 'success');
    if (options.refresh !== false) await loadGuides();
  } catch (error) {
    if (!quiet)
      showStatus(
        error instanceof Error
          ? error.message
          : t('adminGuide.messages.uploadFailed'),
        'error'
      );
    throw error;
  } finally {
    if (!usesExternalProgress) {
      createProgress?.classList.add('hidden');
      if (createProgressLabel) createProgressLabel.textContent = '';
    }
  }
}

function batchStatusText(item: BatchItem): string {
  if (item.status === 'uploading')
    return t('adminGuide.messages.batchUploadingStatus');
  if (item.status === 'completed')
    return t('adminGuide.messages.batchCompleted');
  if (item.status === 'error')
    return item.error || t('adminGuide.messages.batchFailed');
  return t('adminGuide.messages.batchQueued');
}

function renderBatchQueue(): void {
  if (!uploadQueue) return;
  uploadQueue.textContent = '';
  if (batchItems.length === 0) {
    uploadQueue.classList.add('hidden');
    return;
  }
  uploadQueue.classList.remove('hidden');

  const summary = document.createElement('p');
  summary.className =
    'mb-3 text-sm font-semibold text-ink-slate dark:text-content';
  summary.textContent = t('adminGuide.messages.batchSummary', {
    count: batchItems.length,
  });
  uploadQueue.appendChild(summary);

  const items = document.createElement('ol');
  items.className = 'space-y-2';
  batchItems.forEach((item, index) => {
    const row = document.createElement('li');
    row.className =
      'flex flex-col gap-3 rounded-lg border border-outline-variant bg-background p-3 md:flex-row md:items-center md:justify-between';

    const info = document.createElement('div');
    info.className = 'min-w-0';
    const name = document.createElement('p');
    name.className = 'truncate text-sm font-semibold';
    name.textContent = `${index + 1}. ${item.file.name}`;
    const detail = document.createElement('p');
    detail.className = 'mt-1 text-xs text-on-surface-variant';
    detail.textContent = `${t(item.assetType === 'pdf' ? 'adminGuide.type.pdf' : 'adminGuide.type.video')} · ${formatBytes(item.file.size)} · ${t('adminGuide.labels.title')}: ${item.title}`;
    const state = document.createElement('p');
    state.className =
      item.status === 'error'
        ? 'mt-1 text-xs text-red-700 dark:text-red-300'
        : item.status === 'completed'
          ? 'mt-1 text-xs text-emerald-700 dark:text-emerald-300'
          : 'mt-1 text-xs text-on-surface-variant';
    state.textContent = batchStatusText(item);
    info.append(name, detail, state);

    const controls = document.createElement('div');
    controls.className = 'flex shrink-0 flex-wrap items-center gap-2';
    const moveUp = button(
      t('adminGuide.actions.up'),
      'rounded-lg border border-outline-variant px-2.5 py-1.5 text-xs font-semibold hover:border-vibrant-palm disabled:cursor-not-allowed disabled:opacity-40'
    );
    moveUp.disabled = batchUploading || Boolean(item.guide) || index === 0;
    moveUp.setAttribute(
      'aria-label',
      t('adminGuide.actions.moveUpFile', { name: item.file.name })
    );
    moveUp.addEventListener('click', () => moveBatchItem(index, -1));
    const moveDown = button(
      t('adminGuide.actions.down'),
      'rounded-lg border border-outline-variant px-2.5 py-1.5 text-xs font-semibold hover:border-vibrant-palm disabled:cursor-not-allowed disabled:opacity-40'
    );
    moveDown.disabled =
      batchUploading || Boolean(item.guide) || index === batchItems.length - 1;
    moveDown.setAttribute(
      'aria-label',
      t('adminGuide.actions.moveDownFile', { name: item.file.name })
    );
    moveDown.addEventListener('click', () => moveBatchItem(index, 1));
    const remove = button(
      t('adminGuide.actions.removeFromQueue'),
      'rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-300'
    );
    remove.disabled = batchUploading || Boolean(item.guide);
    remove.addEventListener('click', () => removeBatchItem(index));
    controls.append(moveUp, moveDown, remove);
    row.append(info, controls);
    items.appendChild(row);
  });
  uploadQueue.appendChild(items);
}

function moveBatchItem(index: number, delta: -1 | 1): void {
  if (batchUploading || batchItems[index]?.guide) return;
  const target = index + delta;
  if (target < 0 || target >= batchItems.length) return;
  const [moved] = batchItems.splice(index, 1);
  batchItems.splice(target, 0, moved);
  renderBatchQueue();
}

function removeBatchItem(index: number): void {
  if (batchUploading || batchItems[index]?.guide) return;
  batchItems.splice(index, 1);
  renderBatchQueue();
}

function selectBatchFiles(): void {
  if (!fileInput || batchUploading) return;
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) {
    batchItems = [];
    renderBatchQueue();
    return;
  }

  const invalidType = files.filter((file) => !assetTypeFromFilename(file.name));
  const tooLarge = files.filter((file) => file.size > MAX_BYTES);
  const empty = files.filter((file) => file.size <= 0);
  if (invalidType.length || tooLarge.length || empty.length) {
    const invalidNames = [...invalidType, ...tooLarge, ...empty]
      .slice(0, 3)
      .map((file) => file.name)
      .join(', ');
    showStatus(
      t('adminGuide.messages.invalidSelection', { names: invalidNames }),
      'error'
    );
    batchItems = [];
    fileInput.value = '';
    renderBatchQueue();
    return;
  }

  batchItems = files.map((file) => ({
    file,
    title: titleFromFilename(file.name),
    assetType: assetTypeFromFilename(file.name) as AssetType,
    status: 'queued',
  }));
  renderBatchQueue();
  showStatus(
    t('adminGuide.messages.filesReady', { count: batchItems.length }),
    'info'
  );
}

async function createGuideRecord(item: BatchItem): Promise<GuideMaterial> {
  const response = await fetch('/api/admin/guides', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: item.title,
      description: '',
      assetType: item.assetType,
    }),
  });
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as ApiPayload<{
    guide?: GuideMaterial;
  }>;
  if (!payload.data?.guide)
    throw new Error(t('adminGuide.messages.createFailed'));
  return payload.data.guide;
}

async function uploadBatch(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!createButton || batchUploading) return;
  const pending = batchItems.filter((item) => item.status !== 'completed');
  if (pending.length === 0) {
    showStatus(t('adminGuide.messages.selectFile'), 'error');
    return;
  }

  batchUploading = true;
  createButton.disabled = true;
  if (fileInput) fileInput.disabled = true;
  createProgress?.classList.remove('hidden');
  if (createProgress) createProgress.value = 0;

  let uploaded = 0;
  let failed = 0;
  try {
    for (const item of pending) {
      item.status = 'uploading';
      item.error = undefined;
      renderBatchQueue();
      const itemIndex = pending.indexOf(item);
      try {
        item.guide ||= await createGuideRecord(item);
        await uploadGuideFile(item.guide, item.file, {
          silent: true,
          refresh: false,
          onProgress: (sent, total) => {
            const current = total > 0 ? sent / total : 0;
            if (createProgress)
              createProgress.value =
                ((itemIndex + current) / pending.length) * 100;
            if (createProgressLabel)
              createProgressLabel.textContent = t(
                'adminGuide.messages.batchItemUploading',
                {
                  current: itemIndex + 1,
                  total: pending.length,
                  name: item.file.name,
                  sent: formatBytes(sent),
                  size: formatBytes(total),
                }
              );
          },
        });
        item.status = 'completed';
        uploaded += 1;
      } catch (error) {
        item.status = 'error';
        item.error =
          error instanceof Error
            ? error.message
            : t('adminGuide.messages.uploadFailed');
        failed += 1;
      }
      renderBatchQueue();
    }

    await loadGuides();
    if (failed > 0) {
      showStatus(
        t('adminGuide.messages.batchPartial', { uploaded, failed }),
        'error'
      );
    } else {
      if (createProgress) createProgress.value = 100;
      showStatus(
        t('adminGuide.messages.batchSuccess', { uploaded }),
        'success'
      );
      batchItems = [];
      if (fileInput) fileInput.value = '';
      renderBatchQueue();
    }
  } catch (error) {
    showStatus(
      error instanceof Error
        ? error.message
        : t('adminGuide.messages.batchFailedGeneric'),
      'error'
    );
  } finally {
    batchUploading = false;
    createButton.disabled = false;
    if (fileInput) fileInput.disabled = false;
    createProgress?.classList.add('hidden');
    if (createProgressLabel) createProgressLabel.textContent = '';
    renderBatchQueue();
  }
}

async function init(): Promise<void> {
  await initI18n();
  document.addEventListener('igo:languagechange', () => {
    if (guidesLoaded) render(true);
    renderBatchQueue();
  });
  await initAuth();
  requireAdmin();
  fileInput?.addEventListener('change', selectBatchFiles);
  createForm?.addEventListener('submit', (event) => void uploadBatch(event));
  saveOrderButton?.addEventListener('click', () => void saveOrder());
  try {
    await loadGuides();
  } catch (error) {
    showStatus(
      error instanceof Error
        ? error.message
        : t('adminGuide.messages.loadFailed'),
      'error'
    );
  }
}

void init();
