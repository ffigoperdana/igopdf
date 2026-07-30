import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyIgoThemeToPdfJsIframe,
  attachPdfJsThemeSync,
} from '@/js/pdfjs-theme';

function createSameOriginIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  return iframe;
}

function frameRoot(iframe: HTMLIFrameElement): HTMLElement {
  const root = iframe.contentDocument?.documentElement;
  if (!root) throw new Error('Expected a same-origin iframe document');
  return root;
}

describe('PDF.js theme synchronization', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('applies the current IGO theme on attach and PDF.js iframe load', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem(
      'pdfjs.preferences',
      JSON.stringify({ enablePermissions: false })
    );
    const iframe = createSameOriginIframe();

    const detach = attachPdfJsThemeSync(iframe);
    const root = frameRoot(iframe);

    expect(root.style.colorScheme).toBe('dark');
    expect(root.classList.contains('is-dark')).toBe(true);
    expect(root.classList.contains('is-light')).toBe(false);
    expect(
      JSON.parse(localStorage.getItem('pdfjs.preferences') ?? '{}')
    ).toEqual({
      enablePermissions: false,
      viewerCssTheme: 2,
    });

    root.className = 'viewer-reset';
    root.removeAttribute('style');
    iframe.dispatchEvent(new Event('load'));

    expect(root.style.colorScheme).toBe('dark');
    expect(root.classList.contains('is-dark')).toBe(true);
    detach();
  });

  it('updates a loaded viewer on igo:themechange and stops after cleanup', () => {
    const iframe = createSameOriginIframe();
    const detach = attachPdfJsThemeSync(iframe);
    const root = frameRoot(iframe);

    expect(root.classList.contains('is-light')).toBe(true);
    expect(
      JSON.parse(localStorage.getItem('pdfjs.preferences') ?? '{}')
    ).toEqual({ viewerCssTheme: 1 });

    document.documentElement.classList.add('dark');
    document.dispatchEvent(
      new CustomEvent('igo:themechange', { detail: 'dark' })
    );

    expect(root.classList.contains('is-dark')).toBe(true);
    expect(root.classList.contains('is-light')).toBe(false);
    expect(
      JSON.parse(localStorage.getItem('pdfjs.preferences') ?? '{}')
    ).toEqual({ viewerCssTheme: 2 });

    detach();
    document.documentElement.classList.remove('dark');
    document.dispatchEvent(
      new CustomEvent('igo:themechange', { detail: 'light' })
    );

    expect(root.classList.contains('is-dark')).toBe(true);
    expect(
      JSON.parse(localStorage.getItem('pdfjs.preferences') ?? '{}')
    ).toEqual({ viewerCssTheme: 2 });
  });

  it('keeps independent iframe bindings safe when one viewer is replaced', () => {
    const iframes = [
      createSameOriginIframe(),
      createSameOriginIframe(),
      createSameOriginIframe(),
    ];
    const detach = iframes.map((iframe) => attachPdfJsThemeSync(iframe));

    document.documentElement.classList.add('dark');
    document.dispatchEvent(new CustomEvent('igo:themechange'));
    expect(
      iframes.every((iframe) => frameRoot(iframe).classList.contains('is-dark'))
    ).toBe(true);

    detach[0]();
    document.documentElement.classList.remove('dark');
    document.dispatchEvent(new CustomEvent('igo:themechange'));

    expect(frameRoot(iframes[0]).classList.contains('is-dark')).toBe(true);
    expect(frameRoot(iframes[1]).classList.contains('is-light')).toBe(true);
    expect(frameRoot(iframes[2]).classList.contains('is-light')).toBe(true);
    detach[1]();
    detach[2]();
  });

  it('recovers malformed PDF.js preferences without losing DOM sync', () => {
    localStorage.setItem('pdfjs.preferences', '{not-json');
    const iframe = createSameOriginIframe();

    const detach = attachPdfJsThemeSync(iframe);

    expect(frameRoot(iframe).classList.contains('is-light')).toBe(true);
    expect(
      JSON.parse(localStorage.getItem('pdfjs.preferences') ?? '{}')
    ).toEqual({ viewerCssTheme: 1 });
    detach();
  });

  it('does not throw when a future iframe is no longer same-origin', () => {
    const inaccessibleIframe = {
      get contentDocument() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    } as unknown as HTMLIFrameElement;

    expect(applyIgoThemeToPdfJsIframe(inaccessibleIframe, 'dark')).toBe(false);
  });

  it('still applies the iframe theme when browser storage is unavailable', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });
    const iframe = createSameOriginIframe();

    const detach = attachPdfJsThemeSync(iframe);

    expect(frameRoot(iframe).classList.contains('is-light')).toBe(true);
    detach();
    getItem.mockRestore();
  });
});
