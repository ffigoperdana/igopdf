import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createThemeToggle,
  currentTheme,
  initTheme,
  setTheme,
} from '@/js/theme';

type MediaChangeListener = (event: MediaQueryListEvent) => void;

const mediaChangeListeners = new Set<MediaChangeListener>();
const mediaQuery = {
  matches: false,
  media: '(prefers-color-scheme: dark)',
  onchange: null as MediaQueryList['onchange'],
  addEventListener: vi.fn((type: string, listener: unknown) => {
    if (type === 'change' && typeof listener === 'function') {
      mediaChangeListeners.add(listener as MediaChangeListener);
    }
  }),
  removeEventListener: vi.fn((type: string, listener: unknown) => {
    if (type === 'change' && typeof listener === 'function') {
      mediaChangeListeners.delete(listener as MediaChangeListener);
    }
  }),
  addListener: vi.fn((listener: MediaChangeListener) => {
    mediaChangeListeners.add(listener);
  }),
  removeListener: vi.fn((listener: MediaChangeListener) => {
    mediaChangeListeners.delete(listener);
  }),
  dispatchEvent: vi.fn(),
};

function setSystemDark(dark: boolean, dispatch = true): void {
  mediaQuery.matches = dark;
  if (!dispatch) return;

  const event = {
    matches: dark,
    media: mediaQuery.media,
  } as MediaQueryListEvent;
  mediaChangeListeners.forEach((listener) => listener(event));
}

function dispatchStorageChange(
  newValue: string | null,
  key: string | null = 'igo-theme'
): void {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: key },
    newValue: { value: newValue },
  });
  window.dispatchEvent(event);
}

function dispatchPageShow(persisted: boolean): void {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

function listenForThemeChanges(): {
  listener: (event: Event) => void;
  themes: string[];
} {
  const themes: string[] = [];
  const listener = (event: Event) => {
    themes.push((event as CustomEvent<string>).detail);
  };
  document.addEventListener('igo:themechange', listener);
  return { listener, themes };
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => mediaQuery as unknown as MediaQueryList),
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  setSystemDark(false, false);
  document.documentElement.className = '';
  document.head.innerHTML = '<meta name="theme-color" content="#1F5630">';
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('theme runtime', () => {
  it('registers system, storage, and pageshow listeners only once', () => {
    const addWindowListener = vi.spyOn(window, 'addEventListener');

    initTheme();
    initTheme();
    initTheme();

    expect(mediaQuery.addEventListener).toHaveBeenCalledTimes(1);
    expect(mediaChangeListeners.size).toBe(1);
    expect(
      addWindowListener.mock.calls.filter(
        ([type]) => String(type) === 'storage'
      )
    ).toHaveLength(1);
    expect(
      addWindowListener.mock.calls.filter(
        ([type]) => String(type) === 'pageshow'
      )
    ).toHaveLength(1);

    addWindowListener.mockRestore();
  });

  it('follows the system preference live when there is no manual choice', () => {
    setSystemDark(true, false);
    initTheme();
    expect(currentTheme()).toBe('dark');

    const { listener, themes } = listenForThemeChanges();
    setSystemDark(false);
    setSystemDark(true);

    expect(currentTheme()).toBe('dark');
    expect(themes).toEqual(['light', 'dark']);
    document.removeEventListener('igo:themechange', listener);
  });

  it('lets a valid stored preference override system changes', () => {
    setSystemDark(true, false);
    window.localStorage.setItem('igo-theme', 'light');
    initTheme();

    expect(currentTheme()).toBe('light');
    setSystemDark(false);
    setSystemDark(true);
    expect(currentTheme()).toBe('light');

    window.localStorage.setItem('igo-theme', 'dark');
    initTheme();
    setSystemDark(false);
    expect(currentTheme()).toBe('dark');
  });

  it('falls back to system for invalid, removed, or cleared stored values', () => {
    setSystemDark(true, false);
    window.localStorage.setItem('igo-theme', 'invalid');
    initTheme();
    expect(currentTheme()).toBe('dark');

    dispatchStorageChange('light');
    expect(currentTheme()).toBe('light');

    dispatchStorageChange('invalid');
    expect(currentTheme()).toBe('dark');

    dispatchStorageChange('dark');
    setSystemDark(false);
    expect(currentTheme()).toBe('dark');

    dispatchStorageChange(null);
    expect(currentTheme()).toBe('light');

    setSystemDark(true, false);
    dispatchStorageChange(null, null);
    expect(currentTheme()).toBe('dark');
  });

  it('syncs valid preferences received through a cross-tab storage event', () => {
    initTheme();
    const { listener, themes } = listenForThemeChanges();

    dispatchStorageChange('dark');
    expect(currentTheme()).toBe('dark');

    setSystemDark(false);
    expect(currentTheme()).toBe('dark');

    dispatchStorageChange('light');
    expect(currentTheme()).toBe('light');
    expect(themes).toEqual(['dark', 'light']);
    document.removeEventListener('igo:themechange', listener);
  });

  it('re-resolves stored or system theme after a BFCache pageshow', () => {
    window.localStorage.setItem('igo-theme', 'dark');
    initTheme();
    expect(currentTheme()).toBe('dark');

    window.localStorage.setItem('igo-theme', 'light');
    dispatchPageShow(false);
    expect(currentTheme()).toBe('dark');

    dispatchPageShow(true);
    expect(currentTheme()).toBe('light');

    window.localStorage.removeItem('igo-theme');
    setSystemDark(true, false);
    dispatchPageShow(true);
    expect(currentTheme()).toBe('dark');
  });

  it('survives unavailable localStorage while keeping the manual choice in memory', () => {
    setSystemDark(false, false);
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });

    expect(() => initTheme()).not.toThrow();
    expect(currentTheme()).toBe('light');
    getItem.mockRestore();

    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });

    expect(() => setTheme('dark')).not.toThrow();
    expect(currentTheme()).toBe('dark');
    setSystemDark(false);
    expect(currentTheme()).toBe('dark');
    setItem.mockRestore();
  });

  it('persists manual changes, updates metadata, animates, and emits once per effective change', () => {
    initTheme();
    const { listener, themes } = listenForThemeChanges();
    const meta = document.querySelector('meta[name="theme-color"]');

    setTheme('dark');
    expect(window.localStorage.getItem('igo-theme')).toBe('dark');
    expect(currentTheme()).toBe('dark');
    expect(meta?.getAttribute('content')).toBe('#0d1f17');
    expect(document.documentElement.classList.contains('theme-anim')).toBe(
      true
    );
    expect(themes).toEqual(['dark']);

    setTheme('dark');
    expect(themes).toEqual(['dark']);

    vi.advanceTimersByTime(400);
    expect(document.documentElement.classList.contains('theme-anim')).toBe(
      false
    );
    document.removeEventListener('igo:themechange', listener);
  });

  it('creates theme-color metadata when a page does not provide it', () => {
    document.head.innerHTML = '';
    setSystemDark(true, false);

    initTheme();

    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute('content')).toBe('#0d1f17');

    setTheme('light');
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(
      1
    );
    expect(meta?.getAttribute('content')).toBe('#1F5630');
  });

  it('keeps toggle labels, titles, pressed state, and multiple instances in sync', () => {
    initTheme();
    const first = createThemeToggle();
    const second = createThemeToggle('custom-class');
    document.body.append(first, second);

    expect(first.getAttribute('aria-label')).toBe('Switch to dark mode');
    expect(first.title).toBe('Switch to dark mode');
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(second.getAttribute('aria-label')).toBe('Switch to dark mode');

    first.click();

    expect(first.getAttribute('aria-label')).toBe('Switch to light mode');
    expect(first.title).toBe('Switch to light mode');
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(second.getAttribute('aria-label')).toBe('Switch to light mode');
    expect(second.getAttribute('aria-pressed')).toBe('true');

    setTheme('light');
    expect(first.getAttribute('aria-label')).toBe('Switch to dark mode');
    expect(second.getAttribute('aria-label')).toBe('Switch to dark mode');
  });
});
