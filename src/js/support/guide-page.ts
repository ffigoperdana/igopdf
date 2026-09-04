import { initI18n, t } from '../i18n/index.js';

interface GuideMaterial {
  id: string;
  title: string;
  description: string;
  assetType: 'pdf' | 'video';
  originalFilename: string | null;
  position: number;
}

type GuidePageState = 'loading' | 'ready' | 'empty' | 'error';

const list = document.getElementById('guide-list');
const viewer = document.getElementById('guide-viewer');
const viewerTitle = document.getElementById('guide-viewer-title');
const viewerDescription = document.getElementById('guide-viewer-description');
const viewerContent = document.getElementById('guide-viewer-content');

let loadedGuides: GuideMaterial[] = [];
let activeGuide: GuideMaterial | null = null;
let pageState: GuidePageState = 'loading';

function showViewerMessage(messageKey: string): void {
  if (!viewerContent) return;
  viewerContent.textContent = '';
  const paragraph = document.createElement('p');
  paragraph.className = 'py-16 text-center text-sm text-on-surface-variant';
  paragraph.textContent = t(messageKey);
  viewerContent.appendChild(paragraph);
}

function renderListMessage(messageKey: string, className: string): void {
  if (!list) return;
  list.textContent = '';
  const message = document.createElement('p');
  message.className = className;
  message.textContent = t(messageKey);
  list.appendChild(message);
}

function setActiveGuide(guide: GuideMaterial): void {
  activeGuide = guide;
  document
    .querySelectorAll<HTMLButtonElement>('[data-guide-id]')
    .forEach((button) => {
      button.classList.toggle(
        'border-vibrant-palm',
        button.dataset.guideId === guide.id
      );
      button.classList.toggle(
        'bg-orange-50',
        button.dataset.guideId === guide.id
      );
      button.classList.toggle(
        'dark:bg-orange-950/20',
        button.dataset.guideId === guide.id
      );
    });
  if (viewer) viewer.classList.remove('hidden');
  if (viewerTitle) viewerTitle.textContent = guide.title;
  if (viewerDescription) viewerDescription.textContent = guide.description;
  if (!viewerContent) return;

  viewerContent.textContent = '';
  const source = `/api/guides/${encodeURIComponent(guide.id)}/file`;
  if (guide.assetType === 'video') {
    const video = document.createElement('video');
    video.className = 'h-full max-h-[68vh] w-full rounded bg-black';
    video.controls = true;
    video.preload = 'metadata';
    video.src = source;
    viewerContent.appendChild(video);
  } else {
    const frame = document.createElement('iframe');
    frame.className =
      'h-[68vh] w-full rounded border border-outline-variant bg-white';
    frame.title = t('guide.frameTitle', { title: guide.title });
    frame.src = `${source}#view=FitH`;
    viewerContent.appendChild(frame);
  }

  const params = new URLSearchParams(window.location.search);
  params.set('materi', guide.id);
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}?${params.toString()}`
  );
}

function renderGuideList(guides: GuideMaterial[]): void {
  if (!list) return;
  list.textContent = '';
  guides.forEach((guide, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.guideId = guide.id;
    button.className =
      'w-full rounded-lg border border-outline-variant bg-paper-white p-4 text-left transition hover:border-vibrant-palm focus:outline-none focus:ring-2 focus:ring-vibrant-palm/30 dark:bg-surface-raised';

    const top = document.createElement('div');
    top.className = 'flex items-start gap-3';
    const order = document.createElement('span');
    order.className =
      'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vibrant-palm text-xs font-bold text-white';
    order.textContent = String(index + 1);
    const label = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'font-semibold text-ink-slate dark:text-content';
    title.textContent = guide.title;
    const type = document.createElement('p');
    type.className = 'mt-1 text-xs text-on-surface-variant';
    type.textContent = t(
      guide.assetType === 'pdf'
        ? 'guide.assetType.pdf'
        : 'guide.assetType.video'
    );
    label.append(title, type);
    top.append(order, label);
    button.appendChild(top);
    button.addEventListener('click', () => setActiveGuide(guide));
    list.appendChild(button);
  });
}

function refreshTranslatedContent(): void {
  if (pageState === 'empty') {
    renderListMessage(
      'guide.empty',
      'rounded-lg border border-dashed border-outline-variant p-5 text-sm text-on-surface-variant'
    );
    showViewerMessage('guide.emptyViewer');
    return;
  }
  if (pageState === 'error') {
    renderListMessage(
      'guide.loadError',
      'rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700'
    );
    showViewerMessage('guide.viewerError');
    return;
  }
  if (pageState === 'ready') {
    renderGuideList(loadedGuides);
    if (activeGuide) setActiveGuide(activeGuide);
  }
}

async function init(): Promise<void> {
  await initI18n();
  document.addEventListener('igo:languagechange', refreshTranslatedContent);

  try {
    const response = await fetch('/api/guides', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('GUIDE_LOAD_FAILED');
    const payload = (await response.json()) as {
      data?: { guides?: GuideMaterial[] };
    };
    loadedGuides = payload.data?.guides || [];
    if (loadedGuides.length === 0) {
      pageState = 'empty';
      refreshTranslatedContent();
      return;
    }
    pageState = 'ready';
    renderGuideList(loadedGuides);
    const selectedId = new URLSearchParams(window.location.search).get(
      'materi'
    );
    setActiveGuide(
      loadedGuides.find((guide) => guide.id === selectedId) || loadedGuides[0]
    );
  } catch {
    pageState = 'error';
    refreshTranslatedContent();
  }
}

void init();
