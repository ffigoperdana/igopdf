import DOMPurify from 'dompurify';
import { initAuth, requireAdmin } from '../auth/guard.js';
import { formatBytes } from '../utils/helpers-light.js';
import { initI18n, t } from '../i18n/index.js';
import { initRichTextEditor, type RichTextEditor } from './richTextEditor.js';

type Status = 'draft' | 'open' | 'in_progress' | 'resolved';
interface Ticket {
  id: string;
  ticketNumber: string;
  reporterUsername: string;
  category: 'main_feature' | 'other_feature' | 'non_feature';
  featureName: string | null;
  subject: string;
  contentHtml: string;
  contentText: string;
  status: Status;
  submittedAt: string | null;
  resolvedAt: string | null;
  resolutionHtml: string | null;
  resolutionText: string | null;
}
interface Attachment {
  id: string;
  ticketId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string;
  available: boolean;
}
interface Detail extends Ticket {
  attachments: Attachment[];
}

const statusBox = document.getElementById('admin-complaint-status');
const searchInput = document.getElementById(
  'admin-complaint-search'
) as HTMLInputElement | null;
const filterInput = document.getElementById(
  'admin-complaint-filter'
) as HTMLSelectElement | null;
const countLabel = document.getElementById('admin-complaint-count');
const list = document.getElementById('admin-complaint-list');
const detail = document.getElementById('admin-complaint-detail');

let tickets: Ticket[] = [];
let selectedId: string | null = null;
let searchDebounce: number | null = null;
let selectedDetail: Detail | null = null;
let resolutionEditor: RichTextEditor | null = null;
let resolutionDraftHtml: string | null = null;

const editorCommands = [
  ['bold', 'B'],
  ['italic', 'I'],
  ['underline', 'U'],
  ['insertUnorderedList', '• List'],
  ['insertOrderedList', '1. List'],
  ['createLink', 'Link'],
] as const;

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
    const payload = (await response.json()) as { error?: string };
    return (
      payload.error ||
      t('adminComplaint.messages.requestFailed', { status: response.status })
    );
  } catch {
    return t('adminComplaint.messages.requestFailed', {
      status: response.status,
    });
  }
}

function statusLabel(status: Status): string {
  return {
    open: t('adminComplaint.status.open'),
    in_progress: t('adminComplaint.status.inProgress'),
    resolved: t('adminComplaint.status.resolved'),
    draft: t('adminComplaint.status.draft'),
  }[status];
}

function statusClass(status: Status): string {
  return status === 'open'
    ? 'bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300'
    : status === 'in_progress'
      ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
}

function dateLabel(value: string | null): string {
  if (!value) return '-';
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'id-ID';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function renderList(): void {
  if (!list) return;
  list.textContent = '';
  if (countLabel)
    countLabel.textContent = t('adminComplaint.count', {
      count: tickets.length,
    });
  if (tickets.length === 0) {
    const empty = document.createElement('p');
    empty.className =
      'rounded-lg border border-dashed border-outline-variant p-5 text-sm text-on-surface-variant';
    empty.textContent = t('adminComplaint.empty');
    list.appendChild(empty);
    return;
  }
  tickets.forEach((ticket) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `w-full rounded-lg border p-3 text-left transition hover:border-vibrant-palm ${selectedId === ticket.id ? 'border-vibrant-palm bg-orange-50 dark:bg-orange-950/20' : 'border-outline-variant'}`;
    button.addEventListener('click', () => void loadDetail(ticket.id));
    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-2';
    const number = document.createElement('span');
    number.className = 'font-mono text-xs font-bold text-vibrant-palm';
    number.textContent = ticket.ticketNumber;
    const badge = document.createElement('span');
    badge.className = `shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(ticket.status)}`;
    badge.textContent = statusLabel(ticket.status);
    header.append(number, badge);
    const subject = document.createElement('p');
    subject.className =
      'mt-2 truncate text-sm font-semibold text-ink-slate dark:text-content';
    subject.textContent = ticket.subject;
    const meta = document.createElement('p');
    meta.className = 'mt-1 truncate text-xs text-on-surface-variant';
    meta.textContent = `${ticket.reporterUsername} · ${ticket.featureName || t('adminComplaint.outsideFeature')} · ${dateLabel(ticket.submittedAt)}`;
    button.append(header, subject, meta);
    list.appendChild(button);
  });
}

async function loadTickets(): Promise<void> {
  const params = new URLSearchParams({ page: '1', limit: '100' });
  if (searchInput?.value.trim()) params.set('search', searchInput.value.trim());
  if (filterInput?.value) params.set('status', filterInput.value);
  const response = await fetch(`/api/admin/complaints?${params.toString()}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await apiError(response));
  const payload = (await response.json()) as { data?: Ticket[] };
  tickets = payload.data || [];
  if (selectedId && !tickets.some((ticket) => ticket.id === selectedId))
    selectedId = null;
  renderList();
  if (!selectedId && tickets[0]) await loadDetail(tickets[0].id);
}

function addDetailText(
  container: HTMLElement,
  label: string,
  value: string
): void {
  const row = document.createElement('div');
  row.className = 'rounded-lg bg-surface-gray px-3 py-2 dark:bg-surface-muted';
  const heading = document.createElement('p');
  heading.className =
    'text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant';
  heading.textContent = label;
  const content = document.createElement('p');
  content.className = 'mt-1 text-sm text-ink-slate dark:text-content';
  content.textContent = value;
  row.append(heading, content);
  container.appendChild(row);
}

function safeRichText(value: string | null): string {
  return DOMPurify.sanitize(value || '', {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre',
      'a',
    ],
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i,
  });
}

function renderRichText(container: HTMLElement, value: string | null): void {
  container.innerHTML = safeRichText(value);
}

function renderDetail(ticket: Detail): void {
  if (!detail) return;
  if (resolutionEditor && selectedDetail?.status !== 'resolved') {
    resolutionDraftHtml = resolutionEditor.getHtml();
  }
  selectedDetail = ticket;
  resolutionEditor = null;
  if (ticket.status === 'resolved') resolutionDraftHtml = null;
  detail.textContent = '';
  const heading = document.createElement('div');
  heading.className =
    'flex flex-col gap-3 border-b border-outline-variant pb-5 sm:flex-row sm:items-start sm:justify-between';
  const headingText = document.createElement('div');
  const number = document.createElement('p');
  number.className = 'font-mono text-sm font-bold text-vibrant-palm';
  number.textContent = ticket.ticketNumber;
  const title = document.createElement('h2');
  title.className = 'mt-1 text-xl font-bold text-ink-slate dark:text-content';
  title.textContent = ticket.subject;
  const subtitle = document.createElement('p');
  subtitle.className = 'mt-1 text-sm text-on-surface-variant';
  subtitle.textContent = `${ticket.reporterUsername} · ${t('adminComplaint.labels.created')} ${dateLabel(ticket.submittedAt)}`;
  headingText.append(number, title, subtitle);
  const badge = document.createElement('span');
  badge.className = `shrink-0 self-start rounded-full px-3 py-1.5 text-xs font-semibold ${statusClass(ticket.status)}`;
  badge.textContent = statusLabel(ticket.status);
  heading.append(headingText, badge);
  detail.appendChild(heading);

  const metadata = document.createElement('div');
  metadata.className = 'mt-5 grid gap-3 sm:grid-cols-2';
  addDetailText(
    metadata,
    t('adminComplaint.labels.category'),
    ticket.category === 'main_feature'
      ? t('complaint.categories.mainFeature')
      : ticket.category === 'other_feature'
        ? t('complaint.categories.otherFeature')
        : t('complaint.categories.nonFeature')
  );
  addDetailText(
    metadata,
    t('adminComplaint.labels.feature'),
    ticket.featureName || '-'
  );
  detail.appendChild(metadata);

  const contentHeading = document.createElement('h3');
  contentHeading.className =
    'mt-6 text-sm font-bold text-ink-slate dark:text-content';
  contentHeading.textContent = t('adminComplaint.labels.content');
  detail.appendChild(contentHeading);
  const content = document.createElement('div');
  content.className =
    'prose prose-sm mt-2 max-w-none rounded-lg border border-outline-variant p-4 text-ink-slate dark:text-content';
  renderRichText(content, ticket.contentHtml);
  detail.appendChild(content);

  const attachmentsHeading = document.createElement('h3');
  attachmentsHeading.className =
    'mt-6 text-sm font-bold text-ink-slate dark:text-content';
  attachmentsHeading.textContent = t('adminComplaint.labels.attachments', {
    count: ticket.attachments.length,
  });
  detail.appendChild(attachmentsHeading);
  const attachments = document.createElement('div');
  attachments.className = 'mt-2 space-y-2';
  if (ticket.attachments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-on-surface-variant';
    empty.textContent = t('adminComplaint.noAttachments');
    attachments.appendChild(empty);
  }
  ticket.attachments.forEach((attachment) => {
    const row = document.createElement('div');
    row.className =
      'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-outline-variant px-3 py-2';
    const file = document.createElement('span');
    file.className =
      'min-w-0 truncate text-sm text-ink-slate dark:text-content';
    file.textContent = `${attachment.originalFilename} (${formatBytes(attachment.sizeBytes)})`;
    const download = document.createElement('a');
    download.className =
      'shrink-0 text-xs font-semibold text-vibrant-palm hover:underline';
    download.href = `/api/admin/complaints/${encodeURIComponent(ticket.id)}/attachments/${encodeURIComponent(attachment.id)}/download`;
    download.textContent = attachment.available
      ? t('adminComplaint.download')
      : t('adminComplaint.deleted');
    if (!attachment.available) {
      download.removeAttribute('href');
      download.classList.add('cursor-not-allowed', 'text-on-surface-variant');
    }
    row.append(file, download);
    attachments.appendChild(row);
  });
  detail.appendChild(attachments);

  const actions = document.createElement('div');
  actions.className =
    'mt-6 flex flex-wrap gap-2 border-t border-outline-variant pt-5';
  if (ticket.status !== 'resolved') {
    const inProgress = document.createElement('button');
    inProgress.type = 'button';
    inProgress.className =
      'rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold hover:border-vibrant-palm';
    inProgress.textContent =
      ticket.status === 'in_progress'
        ? t('adminComplaint.actions.inProgress')
        : t('adminComplaint.actions.markInProgress');
    inProgress.disabled = ticket.status === 'in_progress';
    inProgress.addEventListener(
      'click',
      () => void changeStatus(ticket.id, 'in_progress')
    );
    actions.appendChild(inProgress);
  }
  detail.appendChild(actions);

  const resolutionHeading = document.createElement('h3');
  resolutionHeading.className =
    'mt-7 text-sm font-bold text-ink-slate dark:text-content';
  resolutionHeading.textContent =
    ticket.status === 'resolved'
      ? t('adminComplaint.actions.resolutionNote')
      : t('adminComplaint.actions.resolve');
  detail.appendChild(resolutionHeading);
  if (ticket.status === 'resolved') {
    const resolution = document.createElement('div');
    resolution.className =
      'prose prose-sm mt-2 max-w-none rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100';
    renderRichText(resolution, ticket.resolutionHtml);
    detail.appendChild(resolution);
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className =
    'mt-2 flex flex-wrap gap-1 rounded-t-lg border border-b-0 border-outline-variant bg-surface-gray p-2 dark:bg-surface-muted';
  const editorElement = document.createElement('div');
  editorElement.className =
    'min-h-40 rounded-b-lg border border-outline-variant bg-background p-4 text-sm focus:outline-none focus:ring-2 focus:ring-vibrant-palm/20';
  editorElement.contentEditable = 'true';
  editorElement.setAttribute('role', 'textbox');
  editorElement.setAttribute('aria-multiline', 'true');
  const count = document.createElement('p');
  count.className = 'mt-2 text-xs text-on-surface-variant';
  const editor = initRichTextEditor({
    editor: editorElement,
    toolbar,
    count,
    minimumCharacters: 250,
    countLabel: (characterCount, minimumCharacters) =>
      t('adminComplaint.characterCount', {
        count: characterCount,
        minimum: minimumCharacters,
      }),
    linkPrompt: () => t('adminComplaint.linkPrompt'),
  });
  resolutionEditor = editor;
  if (resolutionDraftHtml) {
    editorElement.innerHTML = safeRichText(resolutionDraftHtml);
    editor.refresh();
  }
  editorCommands.forEach(([command, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.editorCommand = command;
    button.className =
      'rounded px-2 py-1 text-sm hover:bg-black/10 dark:hover:bg-white/10';
    button.textContent =
      command === 'insertUnorderedList'
        ? t('adminComplaint.toolbar.bulletedButton')
        : command === 'insertOrderedList'
          ? t('adminComplaint.toolbar.numberedButton')
          : command === 'createLink'
            ? t('adminComplaint.toolbar.linkButton')
            : label;
    toolbar.appendChild(button);
  });
  detail.append(toolbar, editorElement, count);
  const resolve = document.createElement('button');
  resolve.type = 'button';
  resolve.className =
    'mt-3 rounded-lg bg-vibrant-palm px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60';
  resolve.textContent = t('adminComplaint.actions.markResolved');
  resolve.addEventListener(
    'click',
    () => void resolveTicket(ticket.id, editor)
  );
  detail.appendChild(resolve);
}

async function loadDetail(id: string): Promise<void> {
  selectedId = id;
  renderList();
  selectedDetail = null;
  resolutionEditor = null;
  resolutionDraftHtml = null;
  if (detail) {
    detail.textContent = '';
    const loading = document.createElement('div');
    loading.className =
      'flex min-h-[420px] items-center justify-center text-sm text-on-surface-variant';
    loading.textContent = t('adminComplaint.messages.loadingDetail');
    detail.appendChild(loading);
  }
  const response = await fetch(
    `/api/admin/complaints/${encodeURIComponent(id)}`,
    { credentials: 'include', cache: 'no-store' }
  );
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  const payload = (await response.json()) as { data?: { ticket?: Detail } };
  if (!payload.data?.ticket) return;
  renderDetail(payload.data.ticket);
}

async function changeStatus(
  id: string,
  status: 'open' | 'in_progress'
): Promise<void> {
  const response = await fetch(
    `/api/admin/complaints/${encodeURIComponent(id)}/status`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }
  );
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  showStatus(t('adminComplaint.messages.statusUpdated'), 'success');
  await loadTickets();
  await loadDetail(id);
}

async function resolveTicket(
  id: string,
  editor: { getHtml(): string; getCharacterCount(): number }
): Promise<void> {
  if (editor.getCharacterCount() < 250) {
    showStatus(t('adminComplaint.messages.minResolution'), 'error');
    return;
  }
  const response = await fetch(
    `/api/admin/complaints/${encodeURIComponent(id)}/resolve`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentHtml: editor.getHtml() }),
    }
  );
  if (!response.ok) {
    showStatus(await apiError(response), 'error');
    return;
  }
  const payload = (await response.json()) as {
    data?: { notification?: { enabled?: boolean; sent?: boolean } };
  };
  const notification = payload.data?.notification;
  showStatus(
    notification?.sent === true
      ? t('adminComplaint.messages.resolvedEmailSent')
      : notification?.enabled === false
        ? t('adminComplaint.messages.resolvedEmailDisabled')
        : t('adminComplaint.messages.resolvedEmailFailed'),
    notification?.sent === true ? 'success' : 'info'
  );
  await loadTickets();
  await loadDetail(id);
}

async function init(): Promise<void> {
  await initI18n();
  document.addEventListener('igo:languagechange', () => {
    renderList();
    if (selectedDetail) renderDetail(selectedDetail);
  });
  await initAuth();
  requireAdmin();
  const refresh = (): void => {
    if (searchDebounce) window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout((): void => {
      void loadTickets().catch((error: unknown): void => {
        showStatus(
          error instanceof Error
            ? error.message
            : t('adminComplaint.messages.loadFailed'),
          'error'
        );
      });
    }, 250);
  };
  searchInput?.addEventListener('input', refresh);
  filterInput?.addEventListener('change', refresh);
  try {
    await loadTickets();
  } catch (error) {
    showStatus(
      error instanceof Error
        ? error.message
        : t('adminComplaint.messages.loadFailed'),
      'error'
    );
  }
}

void init();
