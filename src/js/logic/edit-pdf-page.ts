// Logic for PDF Editor Page
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';
import { makeUniqueFileKey } from '../utils/deduplicate-filename.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';
import {
  warnForLargeClientSideFiles,
  CLIENT_SIDE_LARGE_FILE_BYTES,
} from '../utils/client-file-warning.js';
import { t } from '../i18n/i18n.js';
import { repairPdfEditorFontResources } from '../utils/pdf-editor-compatibility.js';

const embedPdfWasmUrl = new URL(
  'embedpdf-snippet/dist/pdfium.wasm',
  import.meta.url
).href;

import type { EmbedPdfContainer } from 'embedpdf-snippet';
import type {
  AnnotationCapability,
  CommandsCapability,
  InteractionManagerCapability,
  MenuCommandItem,
  SelectionCapability,
  TabItem,
  TabGroupItem,
  ToolbarSchema,
  UICapability,
} from 'embedpdf-snippet';
import type {
  PdfAnnotationObject,
  PdfFreeTextAnnoObject,
  PdfGlyphObject,
  PdfPageObject,
  PdfTextRun,
} from '@embedpdf/models';
import type { PluginRegistry } from '@embedpdf/core';
import type { DocManagerPlugin } from '@/types';

const FREE_TEXT_ANNOTATION_TYPE = 3 as const;
const TEXT_EDIT_MODE = 'igo-edit-text';
const TEXT_EDIT_WORD_TOOLBAR = 'edit-text-word-toolbar';
const TEXT_EDIT_PHRASE_TOOLBAR = 'edit-text-phrase-toolbar';
const STANDARD_FONT_HELVETICA = 4 as const;
const STANDARD_FONT_HELVETICA_BOLD = 5 as const;
const STANDARD_FONT_HELVETICA_ITALIC = 7 as const;
const STANDARD_FONT_TIMES_ROMAN = 8 as const;
const STANDARD_FONT_TIMES_BOLD = 9 as const;
const STANDARD_FONT_TIMES_BOLD_ITALIC = 10 as const;
const STANDARD_FONT_TIMES_ITALIC = 11 as const;

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let annotationPlugin: AnnotationCapability | null = null;
let textEditRegistry: PluginRegistry | null = null;
let textEditInteraction: InteractionManagerCapability | null = null;
let isViewerInitialized = false;
const fileEntryMap = new Map<string, HTMLElement>();
const textEditHandlerCleanups = new Map<string, () => void>();
const appearanceRepairAttempts = new Set<string>();
let textEditToolbarCleanup: (() => void) | null = null;

type PendingTextReplacement = {
  annotationId: string;
  annotation: PdfFreeTextAnnoObject;
  documentId: string;
  page: PdfPageObject;
  run: PdfTextRun;
  originalText: string;
  text: string;
  cancelled: boolean;
};

type ActiveTextEdit = {
  documentId: string;
  page: PdfPageObject;
  run: PdfTextRun;
  text: string;
};

type TextEditScope = 'word' | 'phrase';

type TextEditSelection = {
  run: PdfTextRun;
  text: string;
};

type AnnotationClipboard = {
  annotations: PdfAnnotationObject[];
  pasteCount: number;
};

let annotationClipboard: AnnotationClipboard | null = null;
let activeTextEdit: ActiveTextEdit | null = null;
const pendingTextReplacements: PendingTextReplacement[] = [];
const textEditScopes = new Map<string, TextEditScope>();
const pageTextRunCache = new Map<string, PdfTextRun[]>();
let snapGuideTimer: number | null = null;

function makeAnnotationId(): string {
  return crypto.randomUUID?.() ?? `annotation-${Date.now()}-${Math.random()}`;
}

function blurDeepActiveElement(): void {
  let activeElement: Element | null = document.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  if (activeElement instanceof HTMLElement) activeElement.blur();
}

function waitForAnimationFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const wait = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => wait(remaining - 1));
    };
    wait(count);
  });
}

async function waitForAnnotationChangesToCommit(
  documentId: string,
  timeoutMs = 15_000
): Promise<void> {
  if (!annotationPlugin) return;

  const scope = annotationPlugin.forDocument(documentId);
  const deadline = Date.now() + timeoutMs;

  while (scope.getState().hasPendingChanges) {
    await scope.commit().toPromise();
    if (!scope.getState().hasPendingChanges) return;
    if (Date.now() >= deadline) {
      throw new Error('Timed out while saving PDF annotations');
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const subscription: { unsubscribe?: () => void } = {};
      const finish = () => {
        if (settled) return;
        settled = true;
        subscription.unsubscribe?.();
        resolve();
      };
      subscription.unsubscribe = scope.onStateChange((state) => {
        if (!state.hasPendingChanges) finish();
      });
      window.setTimeout(finish, 50);
    });
  }
}

async function regenerateMissingFreeTextAppearances(
  documentId: string
): Promise<void> {
  if (!annotationPlugin || !docManagerPlugin || !textEditRegistry) return;

  const document = docManagerPlugin.getDocument(documentId);
  if (!document) return;

  const scope = annotationPlugin.forDocument(documentId);
  const annotations = Object.values(scope.getState().byUid).filter(
    ({ object, commitState }) =>
      commitState === 'synced' &&
      object.type === FREE_TEXT_ANNOTATION_TYPE &&
      !object.appearanceModes
  );

  for (const { object } of annotations) {
    const page = document.pages.find((item) => item.index === object.pageIndex);
    if (!page) continue;

    const attemptKey = `${documentId}:${object.id}`;
    if (appearanceRepairAttempts.has(attemptKey)) continue;
    appearanceRepairAttempts.add(attemptKey);

    try {
      await textEditRegistry
        .getEngine()
        .updatePageAnnotation(document, page, object)
        .toPromise();
      scope.invalidatePageAppearances(object.pageIndex);
    } catch (error) {
      console.warn(
        `[PDF Editor] Could not regenerate the appearance for annotation ${object.id}.`,
        error
      );
    }
  }
}

function isEditableEventTarget(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT'
    );
  });
}

function cloneAnnotation(
  annotation: PdfAnnotationObject,
  offset: number
): PdfAnnotationObject {
  const clone = structuredClone(annotation);
  clone.id = makeAnnotationId();
  clone.created = new Date();
  clone.modified = new Date();
  clone.inReplyToId = undefined;
  clone.replyType = undefined;
  clone.appearanceModes = undefined;
  clone.rect = {
    ...clone.rect,
    origin: {
      x: clone.rect.origin.x + offset,
      y: clone.rect.origin.y + offset,
    },
  };
  return clone;
}

const SELECTABLE_ANNOTATION_TYPES = new Set([3, 4, 5, 6, 7, 8, 13, 15]);

function isSelectableAnnotation(annotation: PdfAnnotationObject): boolean {
  return SELECTABLE_ANNOTATION_TYPES.has(annotation.type);
}

function getSelectableAnnotations(
  scope: ReturnType<AnnotationCapability['forDocument']>
): Array<{ pageIndex: number; id: string; annotation: PdfAnnotationObject }> {
  const state = scope.getState();
  return Object.values(state.byUid)
    .filter(
      ({ object, commitState }) =>
        commitState !== 'deleted' && isSelectableAnnotation(object)
    )
    .map(({ object }) => ({
      pageIndex: object.pageIndex,
      id: object.id,
      annotation: object,
    }));
}

function colorToHex(color: PdfTextRun['color']): string {
  const toChannel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value <= 1 ? value * 255 : value)));
  return `#${[color.red, color.green, color.blue]
    .map((value) => toChannel(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

function inferStandardFont(run: PdfTextRun): number {
  const fontName = `${run.font.familyName} ${run.font.name}`.toLowerCase();
  const bold = run.font.weight >= 600 || fontName.includes('bold');
  const italic = run.font.italic || /italic|oblique/.test(fontName);

  if (fontName.includes('times')) {
    if (bold && italic) return STANDARD_FONT_TIMES_BOLD_ITALIC;
    if (bold) return STANDARD_FONT_TIMES_BOLD;
    if (italic) return STANDARD_FONT_TIMES_ITALIC;
    return STANDARD_FONT_TIMES_ROMAN;
  }

  if (bold) return STANDARD_FONT_HELVETICA_BOLD;
  if (italic) return STANDARD_FONT_HELVETICA_ITALIC;
  return STANDARD_FONT_HELVETICA;
}

function countVisibleCharacters(value: string): number {
  return [...value].filter((character) => !/\s/.test(character)).length;
}

function shouldCenterReplacement(originalText: string, replacementText: string) {
  const originalLength = countVisibleCharacters(originalText);
  const replacementLength = countVisibleCharacters(replacementText);
  return originalLength >= 8 && replacementLength <= originalLength * 0.6;
}

function isEditableTextRun(run: PdfTextRun): boolean {
  const fontName = `${run.font.familyName} ${run.font.name}`.toLowerCase();
  return (
    !/glyphless|tesseract|\bocr\b/.test(fontName) &&
    run.rect.size.width > 2 &&
    run.rect.size.height > 2
  );
}

function normalizeExtractedText(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function pageTextRunCacheKey(documentId: string, pageIndex: number): string {
  return `${documentId}:${pageIndex}`;
}

function getTextEditScope(documentId: string): TextEditScope {
  return textEditScopes.get(documentId) ?? 'word';
}

function getTextEditToolbar(scope: TextEditScope): string {
  return scope === 'phrase'
    ? TEXT_EDIT_PHRASE_TOOLBAR
    : TEXT_EDIT_WORD_TOOLBAR;
}

function isTextEditToolbar(toolbarId: string | null): boolean {
  return (
    toolbarId === TEXT_EDIT_WORD_TOOLBAR ||
    toolbarId === TEXT_EDIT_PHRASE_TOOLBAR
  );
}

function createTextEditToolbar(id: string): ToolbarSchema {
  return {
    id,
    position: { placement: 'top', slot: 'secondary', order: 0 },
    permanent: false,
    categories: ['text-edit'],
    items: [
      { type: 'spacer', id: `${id}-spacer-start`, flex: true },
      {
        type: 'group',
        id: `${id}-scope-tools`,
        alignment: 'center',
        gap: 2,
        items: [
          {
            type: 'command-button',
            id: `${id}-scope-word`,
            commandId: 'text-edit:scope-word',
            variant: 'tab',
            categories: ['text-edit'],
          },
          {
            type: 'command-button',
            id: `${id}-scope-phrase`,
            commandId: 'text-edit:scope-phrase',
            variant: 'tab',
            categories: ['text-edit'],
          },
        ],
      },
      { type: 'spacer', id: `${id}-spacer-end`, flex: true },
    ],
  };
}

function getTextEditSnapGuide(): HTMLElement {
  let guide = document.getElementById('text-edit-snap-guide');
  if (guide) return guide;

  guide = document.createElement('div');
  guide.id = 'text-edit-snap-guide';
  guide.setAttribute('aria-hidden', 'true');
  guide.style.cssText =
    'pointer-events:none;position:fixed;inset:0;z-index:90;display:none;';
  const horizontal = document.createElement('div');
  horizontal.dataset.guide = 'horizontal';
  horizontal.style.cssText =
    'position:absolute;height:0;border-top:1px dashed #f59e0b;display:none;';
  const vertical = document.createElement('div');
  vertical.dataset.guide = 'vertical';
  vertical.style.cssText =
    'position:absolute;width:0;border-left:1px dashed #f59e0b;display:none;';
  guide.append(horizontal, vertical);
  document.body.appendChild(guide);
  return guide;
}

function getViewerCanvases(): HTMLCanvasElement[] {
  const container = document.getElementById('embed-pdf-container');
  if (!container) return [];
  const roots: Array<Document | ShadowRoot | HTMLElement> = [container];
  const canvases: HTMLCanvasElement[] = [];
  const seenRoots = new Set<Node>();

  while (roots.length > 0) {
    const root = roots.pop()!;
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    canvases.push(...Array.from(root.querySelectorAll('canvas')));
    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    });
  }

  return canvases
    .filter((canvas) => canvas.getBoundingClientRect().width >= 250)
    .sort(
      (left, right) =>
        left.getBoundingClientRect().top - right.getBoundingClientRect().top
    );
}

function getCompactModeButton(): HTMLButtonElement | null {
  const container = document.getElementById('embed-pdf-container');
  if (!container) return null;

  const roots: Array<Document | ShadowRoot | HTMLElement> = [container];
  const seenRoots = new Set<Node>();
  while (roots.length > 0) {
    const root = roots.pop()!;
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);

    const compactButton = Array.from(root.querySelectorAll('button')).find(
      (button) => {
        const wrapper = button.parentElement;
        return (
          wrapper?.style.width === '100px' &&
          wrapper.style.maxWidth === '100px'
        );
      }
    );
    if (compactButton) return compactButton;

    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    });
  }

  return null;
}

function syncCompactModeLabel(toolbarId: string | null): void {
  const label = isTextEditToolbar(toolbarId)
    ? 'Edit Text'
    : toolbarId === 'annotation-toolbar'
      ? 'Annotate'
      : toolbarId === 'shapes-toolbar'
        ? 'Shapes'
        : toolbarId === 'redaction-toolbar'
          ? 'Redact'
          : 'View';

  // The built-in compact selector only knows its four default modes.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const labelElement = getCompactModeButton()?.querySelector('span');
      if (labelElement) labelElement.textContent = label;
    });
  });
}

function showTextEditSnapGuide(
  page: PdfPageObject,
  x: number | null,
  y: number | null
) {
  if (x === null && y === null) return;
  const canvases = getViewerCanvases();
  const canvas = canvases[page.index] ?? canvases[0];
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;

  const guide = getTextEditSnapGuide();
  const horizontal = guide.querySelector<HTMLElement>('[data-guide="horizontal"]');
  const vertical = guide.querySelector<HTMLElement>('[data-guide="vertical"]');
  const scaleX = bounds.width / page.size.width;
  const scaleY = bounds.height / page.size.height;

  if (horizontal) {
    horizontal.style.display = y === null ? 'none' : 'block';
    horizontal.style.left = `${bounds.left}px`;
    horizontal.style.top = `${bounds.top + (y ?? 0) * scaleY}px`;
    horizontal.style.width = `${bounds.width}px`;
  }
  if (vertical) {
    vertical.style.display = x === null ? 'none' : 'block';
    vertical.style.left = `${bounds.left + (x ?? 0) * scaleX}px`;
    vertical.style.top = `${bounds.top}px`;
    vertical.style.height = `${bounds.height}px`;
  }
  guide.style.display = 'block';
  if (snapGuideTimer !== null) window.clearTimeout(snapGuideTimer);
  snapGuideTimer = window.setTimeout(() => {
    guide.style.display = 'none';
    snapGuideTimer = null;
  }, 900);
}

type AlignmentGuide = {
  origin: number;
  guide: number;
};

function nearestAlignmentGuide(
  current: number,
  candidates: AlignmentGuide[],
  threshold: number
): number | null {
  let closest: AlignmentGuide | null = null;
  let distance = threshold;
  for (const candidate of candidates) {
    const candidateDistance = Math.abs(current - candidate.origin);
    if (candidateDistance <= distance) {
      closest = candidate;
      distance = candidateDistance;
    }
  }
  return closest?.guide ?? null;
}

function getTextEditAlignmentGuides(
  replacement: PendingTextReplacement,
  annotation: PdfFreeTextAnnoObject
) {
  const runs = pageTextRunCache.get(
    pageTextRunCacheKey(replacement.documentId, replacement.page.index)
  );
  if (!runs || runs.length === 0) return null;

  const horizontalPadding = Math.max(1, annotation.fontSize * 0.12);
  const verticalPadding = Math.max(1, annotation.fontSize * 0.2);
  const threshold = Math.max(2.5, annotation.fontSize * 0.34);
  const xCandidates = runs.flatMap((run): AlignmentGuide[] => [
    {
      origin: run.rect.origin.x - horizontalPadding,
      guide: run.rect.origin.x,
    },
    {
      origin:
        run.rect.origin.x +
        run.rect.size.width -
        annotation.rect.size.width +
        horizontalPadding,
      guide: run.rect.origin.x + run.rect.size.width,
    },
    {
      origin:
        run.rect.origin.x +
        run.rect.size.width / 2 -
        annotation.rect.size.width / 2,
      guide: run.rect.origin.x + run.rect.size.width / 2,
    },
  ]);
  const yCandidates = runs.map((run): AlignmentGuide => ({
    origin: run.rect.origin.y - verticalPadding,
    guide: run.rect.origin.y,
  }));
  const guideX = nearestAlignmentGuide(
    annotation.rect.origin.x,
    xCandidates,
    threshold
  );
  const guideY = nearestAlignmentGuide(
    annotation.rect.origin.y,
    yCandidates,
    threshold
  );
  if (guideX === null && guideY === null) return null;

  return {
    guideX,
    guideY,
  };
}

async function getTextForRun(
  document: ReturnType<DocManagerPlugin['getDocument']>,
  page: PdfPageObject,
  run: PdfTextRun
): Promise<string> {
  if (!textEditRegistry || !document) return normalizeExtractedText(run.text);
  const [sliceText] = await textEditRegistry
    .getEngine()
    .getTextSlices(document, [
      {
        pageIndex: page.index,
        charIndex: run.charIndex,
        charCount: run.charCount,
      },
    ])
    .toPromise();
  return normalizeExtractedText(sliceText) || normalizeExtractedText(run.text);
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

function getNearestCharacterIndex(
  run: PdfTextRun,
  text: string,
  glyphs: PdfGlyphObject[],
  position: { x: number; y: number }
): number {
  const textLength = Math.min(text.length, run.charCount);
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < textLength; index += 1) {
    const glyph = glyphs[run.charIndex + index];
    if (!glyph) continue;
    const centerX = glyph.origin.x + glyph.size.width / 2;
    const centerY = glyph.origin.y + glyph.size.height / 2;
    const distance = Math.hypot(position.x - centerX, position.y - centerY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  if (nearestDistance !== Number.POSITIVE_INFINITY) return nearestIndex;
  const relativeX = Math.max(0, position.x - run.rect.origin.x);
  return Math.min(
    Math.max(0, textLength - 1),
    Math.floor((relativeX / Math.max(1, run.rect.size.width)) * textLength)
  );
}

function rectForTextRange(
  run: PdfTextRun,
  glyphs: PdfGlyphObject[],
  start: number,
  end: number,
  textLength: number
): PdfTextRun['rect'] {
  const matchingGlyphs = Array.from({ length: Math.max(0, end - start) }, (_, index) =>
    glyphs[run.charIndex + start + index]
  ).filter((glyph): glyph is PdfGlyphObject => Boolean(glyph));
  if (matchingGlyphs.length === 0) {
    const ratioStart = start / Math.max(1, textLength);
    const ratioEnd = end / Math.max(1, textLength);
    return {
      origin: {
        x: run.rect.origin.x + run.rect.size.width * ratioStart,
        y: run.rect.origin.y,
      },
      size: {
        width: Math.max(1, run.rect.size.width * (ratioEnd - ratioStart)),
        height: run.rect.size.height,
      },
    };
  }

  const left = Math.min(...matchingGlyphs.map((glyph) => glyph.origin.x));
  const top = Math.min(...matchingGlyphs.map((glyph) => glyph.origin.y));
  const right = Math.max(
    ...matchingGlyphs.map((glyph) => glyph.origin.x + glyph.size.width)
  );
  const bottom = Math.max(
    ...matchingGlyphs.map((glyph) => glyph.origin.y + glyph.size.height)
  );
  return {
    origin: { x: left, y: top },
    size: { width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
  };
}

function selectWordFromRun(
  run: PdfTextRun,
  text: string,
  glyphs: PdfGlyphObject[],
  position: { x: number; y: number }
): TextEditSelection {
  if (!text) return { run, text };
  let selectedIndex = getNearestCharacterIndex(run, text, glyphs, position);
  if (!isWordCharacter(text[selectedIndex] ?? '')) {
    const right = [...text.slice(selectedIndex)].findIndex(isWordCharacter);
    const left = [...text.slice(0, selectedIndex)].reverse().findIndex(isWordCharacter);
    if (right >= 0) selectedIndex += right;
    else if (left >= 0) selectedIndex -= left + 1;
  }

  let start = selectedIndex;
  let end = selectedIndex + 1;
  while (start > 0 && isWordCharacter(text[start - 1])) start -= 1;
  while (end < text.length && isWordCharacter(text[end])) end += 1;

  const word = text.slice(start, end);
  return {
    text: word,
    run: {
      ...run,
      text: word,
      rect: rectForTextRange(run, glyphs, start, end, text.length),
      charIndex: run.charIndex + start,
      charCount: end - start,
    },
  };
}

function isOnSameTextLine(reference: PdfTextRun, candidate: PdfTextRun): boolean {
  const referenceCenter = reference.rect.origin.y + reference.rect.size.height / 2;
  const candidateCenter = candidate.rect.origin.y + candidate.rect.size.height / 2;
  return Math.abs(referenceCenter - candidateCenter) <= Math.max(2, reference.fontSize * 0.38);
}

async function selectPhraseFromRuns(
  document: ReturnType<DocManagerPlugin['getDocument']>,
  page: PdfPageObject,
  clickedRun: PdfTextRun,
  runs: PdfTextRun[]
): Promise<TextEditSelection> {
  const lineRuns = runs
    .filter((run) => isEditableTextRun(run) && isOnSameTextLine(clickedRun, run))
    .sort((left, right) => left.rect.origin.x - right.rect.origin.x);
  const clickedIndex = Math.max(0, lineRuns.indexOf(clickedRun));
  let start = clickedIndex;
  let end = clickedIndex;
  const maxGap = Math.max(18, clickedRun.fontSize * 2.2);

  while (
    start > 0 &&
    lineRuns[start].rect.origin.x -
      (lineRuns[start - 1].rect.origin.x + lineRuns[start - 1].rect.size.width) <=
      maxGap
  ) {
    start -= 1;
  }
  while (
    end < lineRuns.length - 1 &&
    lineRuns[end + 1].rect.origin.x -
      (lineRuns[end].rect.origin.x + lineRuns[end].rect.size.width) <=
      maxGap
  ) {
    end += 1;
  }

  const phraseRuns = lineRuns.slice(start, end + 1);
  const parts = await Promise.all(
    phraseRuns.map((run) => getTextForRun(document, page, run))
  );
  const text = parts.reduce((phrase, part, index) => {
    if (!part) return phrase;
    if (!phrase) return part;
    const previous = phraseRuns[index - 1];
    const current = phraseRuns[index];
    const gap = current.rect.origin.x - (previous.rect.origin.x + previous.rect.size.width);
    return `${phrase}${/\s$/.test(phrase) || /^\s/.test(part) || gap < 1 ? '' : ' '}${part}`;
  }, '');
  const left = Math.min(...phraseRuns.map((run) => run.rect.origin.x));
  const top = Math.min(...phraseRuns.map((run) => run.rect.origin.y));
  const right = Math.max(
    ...phraseRuns.map((run) => run.rect.origin.x + run.rect.size.width)
  );
  const bottom = Math.max(
    ...phraseRuns.map((run) => run.rect.origin.y + run.rect.size.height)
  );
  return {
    text: normalizeExtractedText(text),
    run: {
      ...clickedRun,
      text,
      rect: {
        origin: { x: left, y: top },
        size: { width: right - left, height: bottom - top },
      },
      charIndex: phraseRuns[0].charIndex,
      charCount: phraseRuns.reduce((total, run) => total + run.charCount, 0),
    },
  };
}

function findTextRunAtPosition(
  runs: PdfTextRun[],
  position: { x: number; y: number }
): PdfTextRun | null {
  const candidates = runs.filter((run) => {
    if (!isEditableTextRun(run)) return false;
    const padding = Math.max(3, run.fontSize * 0.3);
    const { origin, size } = run.rect;
    return (
      position.x >= origin.x - padding &&
      position.x <= origin.x + size.width + padding &&
      position.y >= origin.y - padding &&
      position.y <= origin.y + size.height + padding
    );
  });

  if (candidates.length === 0) return null;
  return candidates.reduce((closest, run) => {
    const closestArea = closest.rect.size.width * closest.rect.size.height;
    const runArea = run.rect.size.width * run.rect.size.height;
    return runArea < closestArea ? run : closest;
  });
}

function getTextEditDialog(): HTMLDialogElement | null {
  return document.getElementById('text-edit-dialog') as HTMLDialogElement | null;
}

function closeTextEditor() {
  const dialog = getTextEditDialog();
  if (dialog?.open) dialog.close();
  activeTextEdit = null;
}

function openTextEditor(edit: ActiveTextEdit) {
  const dialog = getTextEditDialog();
  const input = document.getElementById('text-edit-value') as HTMLTextAreaElement;
  const fontLabel = document.getElementById('text-edit-font');
  if (!dialog || !input || !fontLabel) return;

  activeTextEdit = edit;
  input.value = edit.text;
  fontLabel.textContent = `${edit.run.font.familyName || edit.run.font.name} - ${Math.round(edit.run.fontSize * 10) / 10} pt`;
  dialog.showModal();
  input.focus();
  input.select();
}

function createReplacementAnnotation(edit: ActiveTextEdit, text: string) {
  const { run, page } = edit;
  const horizontalPadding = Math.max(1, run.fontSize * 0.12);
  const verticalPadding = Math.max(1, run.fontSize * 0.2);
  const textAlign = shouldCenterReplacement(edit.text, text) ? 1 : 0;

  return {
    id: makeAnnotationId(),
    type: FREE_TEXT_ANNOTATION_TYPE,
    pageIndex: page.index,
    contents: text,
    rect: {
      origin: {
        x: Math.max(0, run.rect.origin.x - horizontalPadding),
        y: Math.max(0, run.rect.origin.y - verticalPadding),
      },
      size: {
        width: Math.min(
          page.size.width - run.rect.origin.x + horizontalPadding,
          Math.max(run.rect.size.width + horizontalPadding * 2, 36)
        ),
        height: run.rect.size.height + verticalPadding * 2,
      },
    },
    fontSize: run.fontSize,
    fontFamily: inferStandardFont(run),
    fontColor: colorToHex(run.color),
    textAlign,
    verticalAlign: 0,
    color: '#FFFFFF',
    backgroundColor: '#FFFFFF',
    opacity: 1,
    flags: ['print'],
    created: new Date(),
    modified: new Date(),
  } as PdfFreeTextAnnoObject;
}

function applyTextReplacement() {
  const input = document.getElementById('text-edit-value') as HTMLTextAreaElement;
  if (!activeTextEdit || !input || !annotationPlugin) return;

  const text = input.value.trim();
  if (!text) return;

  const edit = activeTextEdit;
  const annotation = createReplacementAnnotation(edit, text);
  const annotationScope = annotationPlugin.forDocument(edit.documentId);
  annotationScope.createAnnotation(edit.page.index, annotation);
  annotationScope.selectAnnotation(edit.page.index, annotation.id);
  pendingTextReplacements.push({
    annotationId: annotation.id,
    annotation,
    documentId: edit.documentId,
    page: edit.page,
    run: edit.run,
    originalText: edit.text,
    text,
    cancelled: false,
  });
  closeTextEditor();
}

function installTextEditMode(registry: PluginRegistry) {
  const commands = registry
    .getPlugin('commands')
    ?.provides() as CommandsCapability | undefined;
  const ui = registry.getPlugin('ui')?.provides() as UICapability | undefined;
  const selection = registry
    .getPlugin('selection')
    ?.provides() as SelectionCapability | undefined;
  const interaction = registry
    .getPlugin('interaction-manager')
    ?.provides() as InteractionManagerCapability | undefined;
  if (!commands || !ui || !selection || !interaction) return;

  textEditRegistry = registry;
  textEditInteraction = interaction;
  interaction.registerMode({
    id: TEXT_EDIT_MODE,
    scope: 'page',
    exclusive: true,
    cursor: 'text',
  });

  const activateTextEdit = (documentId: string, scope: TextEditScope) => {
    textEditScopes.set(documentId, scope);
    selection.enableForMode(
      TEXT_EDIT_MODE,
      { enableSelection: true, showSelectionRects: true },
      documentId
    );
    ui
      .forDocument(documentId)
      .setActiveToolbar('top', 'secondary', getTextEditToolbar(scope));
    interaction.forDocument(documentId).activate(TEXT_EDIT_MODE);
  };

  commands.registerCommand({
    id: 'mode:edit-text',
    label: 'Edit Text',
    icon: 'replace-text',
    categories: ['text-edit'],
    active: ({ documentId }) =>
      isTextEditToolbar(
        ui.forDocument(documentId).getActiveToolbar('top', 'secondary')
      ),
    action: ({ documentId }) => {
      activateTextEdit(documentId, getTextEditScope(documentId));
    },
  });

  commands.registerCommand({
    id: 'text-edit:scope-word',
    label: 'Word',
    categories: ['text-edit'],
    active: ({ documentId }) =>
      ui.forDocument(documentId).getActiveToolbar('top', 'secondary') ===
      TEXT_EDIT_WORD_TOOLBAR,
    action: ({ documentId }) => activateTextEdit(documentId, 'word'),
  });

  commands.registerCommand({
    id: 'text-edit:scope-phrase',
    label: 'Phrase',
    categories: ['text-edit'],
    active: ({ documentId }) =>
      ui.forDocument(documentId).getActiveToolbar('top', 'secondary') ===
      TEXT_EDIT_PHRASE_TOOLBAR,
    action: ({ documentId }) => activateTextEdit(documentId, 'phrase'),
  });

  commands.registerCommand({
    id: 'annotation:select-all',
    label: 'Select annotations',
    icon: 'marqueeSelect',
    categories: ['annotation', 'annotation-selection'],
    action: ({ documentId }) => {
      if (!annotationPlugin) return;
      const scope = annotationPlugin.forDocument(documentId);
      const annotations = getSelectableAnnotations(scope);
      scope.setSelection(annotations.map(({ id }) => id));
    },
  });

  textEditToolbarCleanup?.();
  textEditToolbarCleanup = ui.onToolbarChanged(
    ({ documentId, placement, slot, toolbarId }) => {
      if (placement !== 'top' || slot !== 'secondary') return;
      syncCompactModeLabel(toolbarId);
      if (isTextEditToolbar(toolbarId)) return;

      const documentInteraction = interaction.forDocument(documentId);
      if (documentInteraction.getActiveMode() === TEXT_EDIT_MODE) {
        documentInteraction.activateDefaultMode();
      }
      if (activeTextEdit?.documentId === documentId) closeTextEditor();
    }
  );

  const schema = ui.getSchema();
  const toolbar = Object.values(schema.toolbars).find((candidate) =>
    candidate.items.some(
      (item) =>
        item.type === 'tab-group' &&
        item.tabs.some((tab) => tab.commandId === 'mode:redact')
    )
  );
  if (!toolbar) return;

  const items = toolbar.items.map((item) => {
    if (
      item.type !== 'tab-group' ||
      !item.tabs.some((tab) => tab.commandId === 'mode:redact')
    ) {
      return item;
    }
    const tabGroup = item as TabGroupItem;
    const editTextTab: TabItem = {
      id: 'mode-edit-text',
      commandId: 'mode:edit-text',
      variant: 'text',
      categories: ['mode', 'text-edit'],
    };
    const overflowIndex = tabGroup.tabs.findIndex(
      (tab) => tab.commandId === 'tabs:overflow-menu'
    );
    const tabs = [...tabGroup.tabs];
    tabs.splice(overflowIndex >= 0 ? overflowIndex : tabs.length, 0, editTextTab);
    return {
      ...tabGroup,
      tabs,
    };
  });

  items.push({
    type: 'command-button',
    id: 'annotation-select-all',
    commandId: 'annotation:select-all',
    variant: 'icon',
    categories: ['annotation', 'annotation-selection'],
  });

  const modeMenu = schema.menus['mode-tabs-overflow-menu'];
  const editTextMenuItem: MenuCommandItem = {
    type: 'command',
    id: 'mode:edit-text',
    commandId: 'mode:edit-text',
    categories: ['mode', 'text-edit'],
  };
  const modeMenuItems = modeMenu
    ? modeMenu.items.some((item) => item.id === editTextMenuItem.id)
      ? modeMenu.items
      : [...modeMenu.items, editTextMenuItem]
    : [];
  const modeMenuResponsive = modeMenu?.responsive
    ? {
        ...modeMenu.responsive,
        breakpoints: Object.fromEntries(
          Object.entries(modeMenu.responsive.breakpoints).map(
            ([breakpoint, rule]) => [
              breakpoint,
              {
                ...rule,
                ...(rule.show
                  ? {
                      show: Array.from(
                        new Set([...rule.show, editTextMenuItem.id])
                      ),
                    }
                  : {}),
              },
            ]
          )
        ),
      }
    : undefined;

  const responsive = {
    ...(toolbar.responsive ?? {}),
    breakpoints: {
      ...(toolbar.responsive?.breakpoints ?? {}),
      'igo-edit-text-compact': {
        maxWidth: 1023,
        hide: ['mode-edit-text'],
      },
      'igo-edit-text-wide': {
        minWidth: 1024,
        show: ['mode-edit-text'],
      },
    },
  };

  ui.mergeSchema({
    toolbars: {
      [toolbar.id]: { ...toolbar, items, responsive },
      [TEXT_EDIT_WORD_TOOLBAR]: createTextEditToolbar(
        TEXT_EDIT_WORD_TOOLBAR
      ),
      [TEXT_EDIT_PHRASE_TOOLBAR]: createTextEditToolbar(
        TEXT_EDIT_PHRASE_TOOLBAR
      ),
    },
    ...(modeMenu
      ? {
          menus: {
            [modeMenu.id]: {
              ...modeMenu,
              items: modeMenuItems,
              responsive: modeMenuResponsive,
            },
          },
        }
      : {}),
  });
}

function registerTextEditHandlers(documentId: string, attempts = 0) {
  if (
    !textEditRegistry ||
    !textEditInteraction ||
    !docManagerPlugin ||
    textEditHandlerCleanups.has(documentId)
  ) {
    return;
  }
  const document = docManagerPlugin.getDocument(documentId);
  if (!document) {
    if (attempts < 6) {
      window.setTimeout(
        () => registerTextEditHandlers(documentId, attempts + 1),
        50
      );
    }
    return;
  }

  const unregister = document.pages.map((page) =>
    textEditInteraction!.registerHandlers({
      documentId,
      pageIndex: page.index,
      modeId: TEXT_EDIT_MODE,
      handlers: {
        onClick: (position) => {
          void (async () => {
            const textRuns = await textEditRegistry!
              .getEngine()
              .getPageTextRuns(document, page)
              .toPromise();
            pageTextRunCache.set(
              pageTextRunCacheKey(documentId, page.index),
              textRuns.runs
            );
            const run = findTextRunAtPosition(textRuns.runs, position);
            if (!run) return;

            const selection =
              getTextEditScope(documentId) === 'phrase'
                ? await selectPhraseFromRuns(document, page, run, textRuns.runs)
                : selectWordFromRun(
                    run,
                    await getTextForRun(document, page, run),
                    await textEditRegistry!
                      .getEngine()
                      .getPageGlyphs(document, page)
                      .toPromise(),
                    position
                  );
            if (!selection.text) {
              showAlert(
                'Text cannot be edited',
                'This PDF does not expose readable text for the selected area. Use a digitally exported PDF with selectable text.'
              );
              return;
            }
            openTextEditor({ documentId, page, ...selection });
          })();
        },
      },
    })
  );

  const annotationScope = annotationPlugin?.forDocument(documentId);
  const unsubscribeAnnotationEvents = annotationScope?.onAnnotationEvent(
    (event) => {
      if (event.type === 'loaded') {
        void regenerateMissingFreeTextAppearances(documentId);
        return;
      }
      const replacement = pendingTextReplacements.find(
        (item) => item.annotationId === event.annotation.id
      );
      if (!replacement) return;
      if (event.type === 'delete') {
        replacement.cancelled = true;
      }
      if (
        event.type === 'update' &&
        event.annotation.type === FREE_TEXT_ANNOTATION_TYPE
      ) {
        replacement.annotation = event.annotation as PdfFreeTextAnnoObject;
        replacement.text = event.annotation.contents;
        if (event.patch.rect) {
          const guides = getTextEditAlignmentGuides(
            replacement,
            replacement.annotation
          );
          if (guides) {
            showTextEditSnapGuide(replacement.page, guides.guideX, guides.guideY);
          }
        }
      }
    }
  );
  textEditHandlerCleanups.set(documentId, () => {
    unregister.forEach((remove) => remove());
    unsubscribeAnnotationEvents?.();
  });
  void regenerateMissingFreeTextAppearances(documentId);
}

function setupAnnotationClipboard(pdfContainer: HTMLElement) {
  pdfContainer.addEventListener('keydown', (event) => {
    if (event.altKey || isEditableEventTarget(event) || !annotationPlugin || !docManagerPlugin) {
      return;
    }

    const documentId = docManagerPlugin.getActiveDocumentId();
    if (!documentId) return;

    const annotationScope = annotationPlugin.forDocument(documentId);
    const selected = annotationScope
      .getSelectedAnnotations()
      .filter(({ object }) => isSelectableAnnotation(object));

    if (event.key === 'Delete') {
      if (selected.length === 0) return;

      annotationScope.deleteAnnotations(
        selected.map(({ object }) => ({
          pageIndex: object.pageIndex,
          id: object.id,
        }))
      );
      event.preventDefault();
      return;
    }

    if ((!event.ctrlKey && !event.metaKey) || !annotationPlugin) return;

    if (event.key.toLowerCase() === 'c') {
      if (selected.length === 0) return;

      annotationClipboard = {
        annotations: selected.map(({ object }) =>
          structuredClone(object)
        ),
        pasteCount: 0,
      };
      event.preventDefault();
      return;
    }

    if (event.key.toLowerCase() !== 'v' || !annotationClipboard) return;

    annotationClipboard.pasteCount += 1;
    const offset = annotationClipboard.pasteCount * 12;
    const duplicates = annotationClipboard.annotations.map((annotation) =>
      cloneAnnotation(annotation, offset)
    );
    duplicates.forEach((duplicate) => {
      annotationScope.createAnnotation(duplicate.pageIndex, duplicate);
    });
    annotationScope.setSelection(duplicates.map(({ id }) => id));
    event.preventDefault();
  });
}

function resetViewer() {
  const pdfWrapper = document.getElementById('embed-pdf-wrapper');
  const pdfContainer = document.getElementById('embed-pdf-container');
  const downloadBtn = document.getElementById('download-edited-pdf');
  const fileDisplayArea = document.getElementById('file-display-area');
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (pdfContainer) pdfContainer.textContent = '';
  if (pdfWrapper) pdfWrapper.classList.add('hidden');
  if (downloadBtn) downloadBtn.classList.add('hidden');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  if (fileInput) fileInput.value = '';
  viewerInstance = null;
  docManagerPlugin = null;
  annotationPlugin = null;
  textEditRegistry = null;
  textEditInteraction = null;
  annotationClipboard = null;
  activeTextEdit = null;
  pendingTextReplacements.length = 0;
  pageTextRunCache.clear();
  if (snapGuideTimer !== null) window.clearTimeout(snapGuideTimer);
  snapGuideTimer = null;
  document.getElementById('text-edit-snap-guide')?.remove();
  textEditToolbarCleanup?.();
  textEditToolbarCleanup = null;
  textEditHandlerCleanups.forEach((cleanup) => cleanup());
  textEditHandlerCleanups.clear();
  appearanceRepairAttempts.clear();
  textEditScopes.clear();
  isViewerInitialized = false;
  fileEntryMap.clear();
}

function removeFileEntry(documentId: string) {
  const entry = fileEntryMap.get(documentId);
  if (entry) {
    entry.remove();
    fileEntryMap.delete(documentId);
  }
  if (fileEntryMap.size === 0) {
    resetViewer();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-palm-500');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-palm-500');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-palm-500');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    });

    fileInput?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
    });
  }

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });

  document
    .getElementById('text-edit-cancel')
    ?.addEventListener('click', closeTextEditor);
  document
    .getElementById('text-edit-cancel-secondary')
    ?.addEventListener('click', closeTextEditor);
  document
    .getElementById('text-edit-form')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      applyTextReplacement();
    });

}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await handleFiles(input.files);
  }
}

async function handleFiles(files: FileList) {
  const pdfFiles = Array.from(files).filter(
    (f) => f.type === 'application/pdf'
  );
  if (pdfFiles.length === 0) {
    showAlert('Invalid File', 'Please upload a valid PDF file.');
    return;
  }

  warnForLargeClientSideFiles(
    pdfFiles,
    t('clientProcessing.editor'),
    CLIENT_SIDE_LARGE_FILE_BYTES
  );

  showLoader('Loading PDF Editor...');

  try {
    const pdfWrapper = document.getElementById('embed-pdf-wrapper');
    const pdfContainer = document.getElementById('embed-pdf-container');
    const fileDisplayArea = document.getElementById('file-display-area');

    if (!pdfWrapper || !pdfContainer || !fileDisplayArea) return;

    hideLoader();
    const decryptedFiles = await batchDecryptIfNeeded(pdfFiles);
    showLoader('Loading PDF Editor...');

    if (decryptedFiles.length === 0) {
      hideLoader();
      return;
    }

    const editorFiles = await Promise.all(
      decryptedFiles.map(repairPdfEditorFontResources)
    );

    if (!isViewerInitialized) {
      const firstFile = editorFiles[0];
      const firstBuffer = await firstFile.arrayBuffer();

      pdfContainer.textContent = '';
      pdfWrapper.classList.remove('hidden');

      const { default: EmbedPDF } = await import('embedpdf-snippet');
      const disabledCategories = getEditorDisabledCategories();
      viewerInstance = EmbedPDF.init({
        disabledCategories,
        type: 'container',
        target: pdfContainer,
        worker: true,
        wasmUrl: embedPdfWasmUrl,
        export: {
          defaultFileName: firstFile.name,
        },
        documentManager: {
          maxDocuments: 10,
        },
        tabBar: 'always',
      });

      const registry = await viewerInstance.registry;
      docManagerPlugin = registry
        .getPlugin('document-manager')
        .provides() as unknown as DocManagerPlugin;
      annotationPlugin = registry
        .getPlugin('annotation')
        .provides() as AnnotationCapability;
      setupAnnotationClipboard(pdfContainer);
      installTextEditMode(registry);

      docManagerPlugin.onDocumentClosed((data: { id?: string }) => {
        const docId = data?.id || '';
        textEditHandlerCleanups.get(docId)?.();
        textEditHandlerCleanups.delete(docId);
        appearanceRepairAttempts.forEach((key) => {
          if (key.startsWith(`${docId}:`)) appearanceRepairAttempts.delete(key);
        });
        textEditScopes.delete(docId);
        pageTextRunCache.forEach((_, key) => {
          if (key.startsWith(`${docId}:`)) pageTextRunCache.delete(key);
        });
        removeFileEntry(docId);
      });

      docManagerPlugin.onDocumentOpened(
        (data: { id?: string; name?: string }) => {
          const docId = data?.id;
          const docKey = data?.name;
          if (!docId) return;
          requestAnimationFrame(() => registerTextEditHandlers(docId));
          const pendingEntry = fileDisplayArea.querySelector(
            `[data-pending-name="${CSS.escape(docKey)}"]`
          ) as HTMLElement;
          if (pendingEntry) {
            pendingEntry.removeAttribute('data-pending-name');
            fileEntryMap.set(docId, pendingEntry);
            const removeBtn = pendingEntry.querySelector(
              '[data-remove-btn]'
            ) as HTMLElement;
            if (removeBtn) {
              removeBtn.onclick = () => {
                docManagerPlugin.closeDocument(docId);
              };
            }
          }
        }
      );

      addFileEntries(fileDisplayArea, editorFiles);

      docManagerPlugin.openDocumentBuffer({
        buffer: firstBuffer,
        name: makeUniqueFileKey(0, firstFile.name),
        autoActivate: true,
      });

      for (let i = 1; i < editorFiles.length; i++) {
        const buffer = await editorFiles[i].arrayBuffer();
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, editorFiles[i].name),
          autoActivate: false,
        });
      }

      isViewerInitialized = true;

      let downloadBtn = document.getElementById('download-edited-pdf');
      if (!downloadBtn) {
        downloadBtn = document.createElement('button');
        downloadBtn.id = 'download-edited-pdf';
        downloadBtn.className = 'btn-gradient w-full mt-6';
        downloadBtn.textContent = 'Download Edited PDF';
        pdfWrapper.appendChild(downloadBtn);
      }
      downloadBtn.classList.remove('hidden');

      downloadBtn.onclick = async () => {
        const originalLabel = downloadBtn.textContent;
        downloadBtn.setAttribute('disabled', 'true');
        downloadBtn.textContent = 'Saving annotations...';
        try {
          const documentId = docManagerPlugin?.getActiveDocumentId();
          if (!documentId) throw new Error('No active PDF document');

          // Match the viewer's built-in Export flow so annotation lifecycle
          // and download behavior remain owned by the viewer.
          blurDeepActiveElement();
          await waitForAnimationFrames();
          await waitForAnnotationChangesToCommit(documentId);
          const commands = registry
            .getPlugin('commands')
            ?.provides() as CommandsCapability | undefined;
          if (!commands) throw new Error('PDF export command is unavailable');
          commands.execute('document:export', documentId, 'ui');
        } catch (err) {
          console.error('Error downloading PDF:', err);
          showAlert('Error', 'Failed to download the edited PDF.');
        } finally {
          downloadBtn.removeAttribute('disabled');
          downloadBtn.textContent = originalLabel;
        }
      };

      const backBtn = document.getElementById('back-to-tools');
      if (backBtn) {
        const newBackBtn = backBtn.cloneNode(true);
        backBtn.parentNode?.replaceChild(newBackBtn, backBtn);

        newBackBtn.addEventListener('click', () => {
          window.location.href = import.meta.env.BASE_URL;
        });
      }
    } else {
      addFileEntries(fileDisplayArea, editorFiles);

      for (let i = 0; i < editorFiles.length; i++) {
        const buffer = await editorFiles[i].arrayBuffer();
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, editorFiles[i].name),
          autoActivate: true,
        });
      }
    }
  } catch (error) {
    console.error('Error loading PDF Editor:', error);
    showAlert('Error', 'Failed to load the PDF Editor.');
  } finally {
    hideLoader();
  }
}

function addFileEntries(fileDisplayArea: HTMLElement, files: File[]) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileDiv = document.createElement('div');
    fileDiv.className =
      'flex items-center justify-between bg-surface-muted p-3 rounded-lg';
    fileDiv.setAttribute('data-pending-name', makeUniqueFileKey(i, file.name));

    const infoContainer = document.createElement('div');
    infoContainer.className = 'flex flex-col flex-1 min-w-0';

    const nameSpan = document.createElement('div');
    nameSpan.className = 'truncate font-medium text-content text-sm mb-1';
    nameSpan.textContent = file.name;

    const metaSpan = document.createElement('div');
    metaSpan.className = 'text-xs text-content-muted';
    metaSpan.textContent = formatBytes(file.size);

    infoContainer.append(nameSpan, metaSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
    removeBtn.setAttribute('data-remove-btn', 'true');
    removeBtn.onclick = () => {
      fileDiv.remove();
      if (fileDisplayArea.children.length === 0) {
        resetViewer();
      }
    };

    fileDiv.append(infoContainer, removeBtn);
    fileDisplayArea.appendChild(fileDiv);
  }

  createIcons({ icons });
}
