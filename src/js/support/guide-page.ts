import { initI18n, t } from '../i18n/index.js';

interface GuideMaterial {
  id: string;
  title: string;
  description: string;
  assetType: 'pdf' | 'video' | 'pptx';
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
type PptxViewerInstance = import('@aiden0z/pptx-renderer').PptxViewer;

interface PptxNavigationControls {
  previousButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  counter: HTMLSpanElement;
}

let activePptxViewer: PptxViewerInstance | null = null;
let pptxAbortController: AbortController | null = null;
let pptxRenderGeneration = 0;

function updatePptxNavigation(
  controls: PptxNavigationControls,
  currentIndex: number,
  slideCount: number
): void {
  const total = Math.max(0, slideCount);
  const current =
    total === 0 ? 0 : Math.min(Math.max(currentIndex + 1, 1), total);
  controls.counter.textContent = t('guide.slideCounter', {
    current,
    total,
  });
  controls.previousButton.disabled = current <= 1;
  controls.nextButton.disabled = total === 0 || current >= total;
}

function clearPptxViewer(): void {
  pptxRenderGeneration += 1;
  pptxAbortController?.abort();
  pptxAbortController = null;
  activePptxViewer?.destroy();
  activePptxViewer = null;
}

function showViewerMessage(messageKey: string): void {
  if (!viewerContent) return;
  clearPptxViewer();
  viewerContent.textContent = '';
  const paragraph = document.createElement('p');
  paragraph.className = 'py-16 text-center text-sm text-on-surface-variant';
  paragraph.textContent = t(messageKey);
  viewerContent.appendChild(paragraph);
}

async function renderPptxViewer(
  guide: GuideMaterial,
  source: string,
  container: HTMLDivElement,
  loadingMessage: HTMLParagraphElement,
  controls: PptxNavigationControls,
  generation: number,
  abortController: AbortController
): Promise<void> {
  try {
    const response = await fetch(source, {
      credentials: 'include',
      cache: 'no-store',
      signal: abortController.signal,
    });
    if (!response.ok) throw new Error('PPTX_LOAD_FAILED');

    const buffer = await response.arrayBuffer();
    if (
      generation !== pptxRenderGeneration ||
      activeGuide?.id !== guide.id ||
      !container.isConnected
    ) {
      return;
    }

    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } =
      await import('@aiden0z/pptx-renderer');
    if (
      generation !== pptxRenderGeneration ||
      activeGuide?.id !== guide.id ||
      !container.isConnected
    ) {
      return;
    }

    let openedViewer: PptxViewerInstance | null = null;
    const pptxViewer = await PptxViewer.open(buffer, container, {
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      pdfjs: false,
      signal: abortController.signal,
      renderMode: 'slide',
      onSlideChange: (index) => {
        if (
          !openedViewer ||
          generation !== pptxRenderGeneration ||
          activeGuide?.id !== guide.id
        ) {
          return;
        }
        updatePptxNavigation(controls, index, openedViewer.slideCount);
      },
    });

    if (
      generation !== pptxRenderGeneration ||
      activeGuide?.id !== guide.id ||
      !container.isConnected
    ) {
      pptxViewer.destroy();
      return;
    }

    activePptxViewer = pptxViewer;
    openedViewer = pptxViewer;
    updatePptxNavigation(
      controls,
      pptxViewer.currentSlideIndex,
      pptxViewer.slideCount
    );
    loadingMessage.remove();
  } catch (error) {
    if (
      abortController.signal.aborted ||
      generation !== pptxRenderGeneration ||
      activeGuide?.id !== guide.id
    ) {
      return;
    }

    loadingMessage.className =
      'rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200';
    loadingMessage.textContent = t('guide.pptxLoadError');
    controls.counter.textContent = t('guide.pptxLoadError');
    controls.previousButton.disabled = true;
    controls.nextButton.disabled = true;
    console.warn('PPTX preview failed', error);
  }
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
  clearPptxViewer();
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
  } else if (guide.assetType === 'pptx') {
    const presentation = document.createElement('div');
    presentation.className = 'space-y-3';
    const loadingMessage = document.createElement('p');
    loadingMessage.className =
      'rounded-lg border border-outline-variant bg-background p-4 text-center text-sm text-on-surface-variant';
    loadingMessage.setAttribute('aria-live', 'polite');
    loadingMessage.textContent = t('guide.pptxLoading');
    const pptxContainer = document.createElement('div');
    pptxContainer.className =
      'h-[68vh] min-h-[28rem] w-full overflow-hidden rounded-lg border border-outline-variant bg-background';
    pptxContainer.setAttribute(
      'aria-label',
      t('guide.frameTitle', { title: guide.title })
    );
    const navigation = document.createElement('div');
    navigation.className = 'flex items-center justify-between gap-3';
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className =
      'rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold text-on-surface transition hover:border-vibrant-palm disabled:cursor-not-allowed disabled:opacity-50';
    previousButton.textContent = `← ${t('guide.previousSlide')}`;
    previousButton.disabled = true;
    const counter = document.createElement('span');
    counter.className =
      'text-center text-sm font-semibold text-on-surface-variant';
    counter.setAttribute('aria-live', 'polite');
    counter.textContent = t('guide.pptxLoading');
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className =
      'rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold text-on-surface transition hover:border-vibrant-palm disabled:cursor-not-allowed disabled:opacity-50';
    nextButton.textContent = `${t('guide.nextSlide')} →`;
    nextButton.disabled = true;
    const controls: PptxNavigationControls = {
      previousButton,
      nextButton,
      counter,
    };
    previousButton.addEventListener('click', () => {
      const currentViewer = activePptxViewer;
      if (!currentViewer || currentViewer.currentSlideIndex <= 0) return;
      void currentViewer
        .goToSlide(currentViewer.currentSlideIndex - 1)
        .catch(() => {});
    });
    nextButton.addEventListener('click', () => {
      const currentViewer = activePptxViewer;
      if (
        !currentViewer ||
        currentViewer.currentSlideIndex >= currentViewer.slideCount - 1
      ) {
        return;
      }
      void currentViewer
        .goToSlide(currentViewer.currentSlideIndex + 1)
        .catch(() => {});
    });
    navigation.append(previousButton, counter, nextButton);
    const fallbackMessage = document.createElement('p');
    fallbackMessage.className = 'text-sm text-on-surface-variant';
    fallbackMessage.textContent = t('guide.pptxDownloadMessage');
    const download = document.createElement('a');
    download.className =
      'inline-flex items-center rounded-lg bg-vibrant-palm px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600';
    download.href = source;
    download.download = guide.originalFilename || `${guide.title}.pptx`;
    download.textContent = t('guide.downloadPptx');
    presentation.append(
      loadingMessage,
      pptxContainer,
      navigation,
      fallbackMessage,
      download
    );
    viewerContent.appendChild(presentation);
    const abortController = new AbortController();
    pptxAbortController = abortController;
    const generation = pptxRenderGeneration;
    void renderPptxViewer(
      guide,
      source,
      pptxContainer,
      loadingMessage,
      controls,
      generation,
      abortController
    );
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
        : guide.assetType === 'video'
          ? 'guide.assetType.video'
          : 'guide.assetType.pptx'
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
