type IgoTheme = 'light' | 'dark';

const PDFJS_PREFERENCES_KEY = 'pdfjs.preferences';
const PDFJS_LIGHT_THEME = 1;
const PDFJS_DARK_THEME = 2;

function currentIgoTheme(ownerDocument: Document): IgoTheme {
  return ownerDocument.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}

function persistPdfJsTheme(ownerDocument: Document, theme: IgoTheme): void {
  try {
    const storage = ownerDocument.defaultView?.localStorage;
    if (!storage) return;

    const raw = storage.getItem(PDFJS_PREFERENCES_KEY);
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
    }
    const preferences =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const viewerCssTheme =
      theme === 'dark' ? PDFJS_DARK_THEME : PDFJS_LIGHT_THEME;

    if (preferences.viewerCssTheme === viewerCssTheme) return;

    storage.setItem(
      PDFJS_PREFERENCES_KEY,
      JSON.stringify({ ...preferences, viewerCssTheme })
    );
  } catch {
    // Theme syncing must not prevent a PDF viewer from loading when storage is
    // unavailable or contains malformed JSON.
  }
}

export function applyIgoThemeToPdfJsIframe(
  iframe: HTMLIFrameElement,
  theme: IgoTheme
): boolean {
  try {
    const frameDocument =
      iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
    const root = frameDocument?.documentElement;
    if (!root) return false;

    // Current PDF.js uses `color-scheme` in the standard viewer and explicit
    // `is-light` / `is-dark` classes in the annotation-extension viewer.
    root.style.colorScheme = theme;
    root.classList.toggle('is-dark', theme === 'dark');
    root.classList.toggle('is-light', theme === 'light');
    return true;
  } catch {
    // Access can fail if a viewer is ever moved to another origin. Treat that
    // as an unsupported viewer rather than breaking the host tool page.
    return false;
  }
}

/**
 * Keeps a same-origin PDF.js iframe aligned with IGO's active theme.
 *
 * Call the returned function before removing or replacing the iframe.
 */
export function attachPdfJsThemeSync(
  iframe: HTMLIFrameElement,
  ownerDocument: Document = document
): () => void {
  let active = true;

  const apply = () => {
    if (!active) return;
    const theme = currentIgoTheme(ownerDocument);
    persistPdfJsTheme(ownerDocument, theme);
    applyIgoThemeToPdfJsIframe(iframe, theme);
  };

  const handleLoad = () => apply();
  const handleThemeChange = () => apply();

  // Persist before navigation so PDF.js initializes in the correct mode, then
  // re-apply on load to cover both supported viewer implementations.
  apply();
  iframe.addEventListener('load', handleLoad);
  ownerDocument.addEventListener('igo:themechange', handleThemeChange);

  return () => {
    if (!active) return;
    active = false;
    iframe.removeEventListener('load', handleLoad);
    ownerDocument.removeEventListener('igo:themechange', handleThemeChange);
  };
}
