import i18next from 'i18next';
import HttpBackend from 'i18next-http-backend';

export const supportedLanguages = ['id', 'en'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const languageNames: Record<SupportedLanguage, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
};

const LANGUAGE_PREFIX = /^\/(id|en)(?:\/|$)/;

export const getLanguageFromUrl = (): SupportedLanguage => {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  let path = window.location.pathname;

  if (basePath && basePath !== '/' && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || '/';
  }

  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  const langMatch = path.match(LANGUAGE_PREFIX);
  if (
    langMatch &&
    supportedLanguages.includes(langMatch[1] as SupportedLanguage)
  ) {
    return langMatch[1] as SupportedLanguage;
  }

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

export const changeLanguage = (lang: SupportedLanguage): void => {
  if (!supportedLanguages.includes(lang)) return;
  localStorage.setItem('i18nextLng', lang);

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  let relativePath = window.location.pathname;

  if (basePath && basePath !== '/' && relativePath.startsWith(basePath)) {
    relativePath = relativePath.slice(basePath.length) || '/';
  }

  if (!relativePath.startsWith('/')) {
    relativePath = '/' + relativePath;
  }

  let pagePathWithoutLang = relativePath;
  const langPrefixMatch = relativePath.match(/^\/(id|en)(\/.*)?$/);
  if (langPrefixMatch) {
    pagePathWithoutLang = langPrefixMatch[2] || '/';
  }

  if (!pagePathWithoutLang.startsWith('/')) {
    pagePathWithoutLang = '/' + pagePathWithoutLang;
  }

  const newRelativePath =
    lang === 'id' ? pagePathWithoutLang : `/${lang}${pagePathWithoutLang}`;

  const newPath =
    basePath && basePath !== '/'
      ? `${basePath}${newRelativePath}`
      : newRelativePath;

  const newUrl =
    newPath.replace(/\/+/g, '/') + window.location.search + window.location.hash;
  window.location.href = newUrl;
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
  const currentLang = getLanguageFromUrl();
  if (currentLang === 'id') return;

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const links = document.querySelectorAll('a[href]');

  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (!href) return;

    if (
      href.startsWith('http') ||
      href.startsWith('//') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('data:') ||
      href.startsWith('vbscript:')
    ) {
      return;
    }

    if (href.includes('/assets/')) {
      return;
    }

    const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const langPrefixRegex = new RegExp(`^(${escapedBase})?/?(id|en)(/|$)`);
    if (langPrefixRegex.test(href)) {
      return;
    }

    let newHref: string;
    if (basePath && basePath !== '/' && href.startsWith(basePath)) {
      const pathAfterBase = href.slice(basePath.length);
      newHref = `${basePath}/${currentLang}${pathAfterBase}`;
    } else if (href.startsWith('/')) {
      newHref =
        basePath && basePath !== '/'
          ? `${basePath}/${currentLang}${href}`
          : `/${currentLang}${href}`;
    } else if (href === '' || href === 'index.html') {
      newHref =
        basePath && basePath !== '/'
          ? `${basePath}/${currentLang}/`
          : `/${currentLang}/`;
    } else {
      newHref = `/${currentLang}/${href}`;
    }

    link.setAttribute('href', newHref.replace(/([^:])\/+/g, '$1/'));
  });
};

export default i18next;
