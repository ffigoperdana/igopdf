import { getLanguageFromUrl, changeLanguage } from './i18n';

// The app only supports id + en (see supportedLanguages), so a compact
// segmented ID|EN pill replaces the old searchable dropdown.
const LANGS: { code: 'id' | 'en'; label: string }[] = [
  { code: 'id', label: 'ID' },
  { code: 'en', label: 'EN' },
];

export const createLanguageSwitcher = (): HTMLElement => {
  const current = getLanguageFromUrl();

  const group = document.createElement('div');
  group.id = 'language-switcher';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language');
  group.className =
    'inline-flex items-center gap-0.5 rounded-full border border-white/25 bg-black/10 p-0.5';

  LANGS.forEach(({ code, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.lang = code;
    btn.textContent = label;
    const active = code === current;
    btn.setAttribute('aria-pressed', String(active));
    btn.className = active
      ? 'px-2.5 py-1 text-xs font-bold rounded-full bg-white text-deep-forest'
      : 'px-2.5 py-1 text-xs font-bold rounded-full text-white/80 hover:text-white';
    btn.addEventListener('click', () => {
      if (code !== current) changeLanguage(code);
    });
    group.appendChild(btn);
  });

  return group;
};

export const injectLanguageSwitcher = (): void => {
  ['language-switcher-container', 'mobile-language-switcher-container', 'simple-mode-language-switcher'].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = '';
        el.appendChild(createLanguageSwitcher());
      }
    }
  );
};
