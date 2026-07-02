// Light/dark theme: applies a `.dark` class on <html>, persists the choice, and
// falls back to the OS preference. A no-flash inline snippet in each page <head>
// applies the class before paint; this module owns runtime toggling + the button.

const STORAGE_KEY = 'igo-theme';

export type Theme = 'light' | 'dark';

function storedTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  // Keep the mobile browser chrome in sync (green nav in light, navy in dark).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#1F5630');
}

export function initTheme(): void {
  applyTheme(storedTheme() ?? systemTheme());
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  // Briefly enable smooth color transitions only during the switch (the
  // `.theme-anim` rule in styles.css) so the flip glides instead of snapping.
  const root = document.documentElement;
  root.classList.add('theme-anim');
  applyTheme(theme);
  window.setTimeout(() => root.classList.remove('theme-anim'), 400);
  document.dispatchEvent(new CustomEvent('igo:themechange', { detail: theme }));
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
  btn.setAttribute('aria-label', 'Toggle dark mode');
  btn.title = 'Toggle theme';
  const base =
    'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors';
  btn.className = `${base} ${extraClass}`.trim();

  const render = () => {
    btn.innerHTML = currentTheme() === 'dark' ? ICON_SUN : ICON_MOON;
  };
  render();

  btn.addEventListener('click', () => {
    toggleTheme();
    render();
  });
  document.addEventListener('igo:themechange', render);
  return btn;
}
