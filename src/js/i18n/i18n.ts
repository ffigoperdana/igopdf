import i18next from 'i18next';
import HttpBackend from 'i18next-http-backend';

export const supportedLanguages = ['id', 'en'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const languageNames: Record<SupportedLanguage, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
};

// NOTE: This deployment does not pre-generate per-language static pages
// (that would require wiring scripts/generate-i18n-pages.mjs into the
// Docker build, which also hardcodes upstream BentoPDF branding). So the
// language is intentionally never encoded in the URL path — `changeLanguage`
// below reloads the current page in place instead of navigating to a
// /en/... or /id/... URL that wouldn't actually exist on disk. The function
// name is kept for compatibility with existing callers even though it no
// longer reads anything from the URL.
export const getLanguageFromUrl = (): SupportedLanguage => {
  const storedLang = localStorage.getItem('i18nextLng');
  if (
    storedLang &&
    supportedLanguages.includes(storedLang as SupportedLanguage)
  ) {
    return storedLang as SupportedLanguage;
  }

  if (typeof navigator !== 'undefined' && navigator.languages) {
    for (const lang of navigator.languages) {
      if (supportedLanguages.includes(lang as SupportedLanguage)) {
        return lang as SupportedLanguage;
      }

      const primaryLang = lang.split('-')[0];
      if (supportedLanguages.includes(primaryLang as SupportedLanguage)) {
        return primaryLang as SupportedLanguage;
      }
    }
  }

  const envLang = import.meta.env?.VITE_DEFAULT_LANGUAGE;
  if (envLang && supportedLanguages.includes(envLang as SupportedLanguage)) {
    return envLang as SupportedLanguage;
  }

  return 'id';
};

let initialized = false;

export const initI18n = async (): Promise<typeof i18next> => {
  if (initialized) return i18next;

  const currentLang = getLanguageFromUrl();

  localStorage.setItem('i18nextLng', currentLang);

  await i18next.use(HttpBackend).init({
    lng: currentLang,
    fallbackLng: 'id',
    supportedLngs: supportedLanguages as unknown as string[],
    ns: ['common', 'tools'],
    defaultNS: 'common',
    preload: [currentLang],
    backend: {
      loadPath: `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}locales/{{lng}}/{{ns}}.json`,
    },
    interpolation: {
      escapeValue: false,
    },
  });

  await i18next.loadNamespaces('tools');

  initialized = true;
  return i18next;
};

export const t = (key: string, options?: Record<string, unknown>): string => {
  return i18next.t(key, options);
};

export const changeLanguage = async (lang: SupportedLanguage): Promise<void> => {
  if (!supportedLanguages.includes(lang) || lang === i18next.language) return;
  localStorage.setItem('i18nextLng', lang);
  // In-place switch (no reload → no white flash). i18next loads the target
  // language's namespaces, then we re-run applyTranslations() over every
  // [data-i18n] node and notify listeners (e.g. to refresh the ID|EN pill).
  await i18next.changeLanguage(lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent('igo:languagechange', { detail: lang }));
};

export const applyTranslations = (): void => {
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      const translation = t(key);
      if (translation && translation !== key) {
        element.textContent = translation;
      }
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    const key = element.getAttribute('data-i18n-placeholder');
    if (key && element instanceof HTMLInputElement) {
      const translation = t(key);
      if (translation && translation !== key) {
        element.placeholder = translation;
      }
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const key = element.getAttribute('data-i18n-title');
    if (key) {
      const translation = t(key);
      if (translation && translation !== key) {
        (element as HTMLElement).title = translation;
      }
    }
  });

  document.documentElement.lang = i18next.language;
  document.documentElement.dir = 'ltr';
};

export const rewriteLinks = (): void => {
  // No-op: URLs are never language-prefixed in this deployment (see
  // changeLanguage() above), so internal links don't need rewriting.
  // Kept as an exported no-op rather than removed so existing callers
  // (main.ts) don't need to change.
};

export default i18next;
