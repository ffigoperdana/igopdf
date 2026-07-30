// Light/dark theme: applies a `.dark` class on <html>, persists the choice, and
// falls back to the OS preference. A no-flash inline snippet in each page <head>
// applies the class before paint; this module owns runtime toggling + the button.

const STORAGE_KEY = 'igo-theme';
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

export type Theme = 'light' | 'dark';

let manualTheme: Theme | null = null;
let systemThemeQuery: MediaQueryList | null = null;
let listeningSystemThemeQuery: MediaQueryList | null = null;
let storageListenerInitialized = false;
let pageShowListenerInitialized = false;
let themeAnimationTimer: number | undefined;

function parseTheme(value: string | null): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

function storedTheme(): Theme | null {
  try {
    return parseTheme(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Applying the user's choice in this tab is still useful when storage is
    // unavailable (for example, in a restricted or sandboxed browser context).
  }
}

function getSystemThemeQuery(): MediaQueryList | null {
  if (systemThemeQuery) return systemThemeQuery;
  try {
    systemThemeQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(SYSTEM_THEME_QUERY)
        : null;
  } catch {
    systemThemeQuery = null;
  }
  return systemThemeQuery;
}

function systemTheme(): Theme {
  return getSystemThemeQuery()?.matches ? 'dark' : 'light';
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  // Keep the mobile browser chrome in sync (green in light, deep green in dark).
  let meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]'
  );
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = theme === 'dark' ? '#0d1f17' : '#1F5630';
}

function dispatchThemeChange(theme: Theme): void {
  document.dispatchEvent(
    new CustomEvent<Theme>('igo:themechange', { detail: theme })
  );
}

function applyResolvedTheme(theme: Theme, animate = false): void {
  const changed = currentTheme() !== theme;

  if (animate && changed) {
    const root = document.documentElement;
    root.classList.add('theme-anim');
    if (themeAnimationTimer !== undefined) {
      window.clearTimeout(themeAnimationTimer);
    }
    themeAnimationTimer = window.setTimeout(() => {
      root.classList.remove('theme-anim');
      themeAnimationTimer = undefined;
    }, 400);
  }

  applyTheme(theme);
  if (changed) dispatchThemeChange(theme);
}

function refreshThemeFromPreference(): void {
  manualTheme = storedTheme();
  applyResolvedTheme(manualTheme ?? systemTheme());
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  if (manualTheme !== null) return;
  applyResolvedTheme(event.matches ? 'dark' : 'light');
}

function handleStorageChange(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  manualTheme = parseTheme(event.newValue);
  applyResolvedTheme(manualTheme ?? systemTheme());
}

function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  refreshThemeFromPreference();
}

function ensureRuntimeListeners(): void {
  const query = getSystemThemeQuery();
  if (query && listeningSystemThemeQuery !== query) {
    if (listeningSystemThemeQuery) {
      if (typeof listeningSystemThemeQuery.removeEventListener === 'function') {
        listeningSystemThemeQuery.removeEventListener(
          'change',
          handleSystemThemeChange
        );
      } else {
        listeningSystemThemeQuery.removeListener(handleSystemThemeChange);
      }
    }

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handleSystemThemeChange);
    } else {
      query.addListener(handleSystemThemeChange);
    }
    listeningSystemThemeQuery = query;
  }

  if (!storageListenerInitialized) {
    window.addEventListener('storage', handleStorageChange);
    storageListenerInitialized = true;
  }

  if (!pageShowListenerInitialized) {
    window.addEventListener('pageshow', handlePageShow);
    pageShowListenerInitialized = true;
  }
}

export function initTheme(): void {
  ensureRuntimeListeners();
  refreshThemeFromPreference();
}

export function setTheme(theme: Theme): void {
  manualTheme = theme;
  persistTheme(theme);
  // Briefly enable smooth color transitions only during the switch (the
  // `.theme-anim` rule in styles.css) so the flip glides instead of snapping.
  applyResolvedTheme(theme, true);
}

export function toggleTheme(): void {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

const ICON_SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-5 w-5"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-5 w-5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

/** A sun/moon icon button that toggles the theme. `extraClass` styles it per host. */
export function createThemeToggle(extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const base =
    'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors';
  btn.className = `${base} ${extraClass}`.trim();

  const render = () => {
    const isDark = currentTheme() === 'dark';
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.innerHTML = isDark ? ICON_SUN : ICON_MOON;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(isDark));
    btn.title = label;
  };
  render();

  btn.addEventListener('click', toggleTheme);
  document.addEventListener('igo:themechange', render);
  return btn;
}
