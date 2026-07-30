import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initFloatingNews } from '@/js/floating-news';

function renderFloatingNews(): void {
  document.body.innerHTML = `
    <aside id="igo-floating-news">
      <section id="floating-news-panel" aria-hidden="true">
        <button id="floating-news-close" type="button">Close</button>
        <div class="floating-news__viewport">
          <div id="floating-news-track">
            <article class="floating-news__slide"></article>
            <article class="floating-news__slide"></article>
            <article class="floating-news__slide"></article>
          </div>
        </div>
        <button id="floating-news-prev" type="button">Previous</button>
        <button id="floating-news-next" type="button">Next</button>
        <span id="floating-news-position"></span>
      </section>
      <button
        id="floating-news-toggle"
        type="button"
        aria-expanded="false"
        aria-controls="floating-news-panel"
      >
        Info
      </button>
    </aside>
  `;
}

function dispatchPageShow(persisted: boolean): void {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

describe('floating news', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    window.history.replaceState({}, '', '/index.html');
    renderFloatingNews();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the gratification notice on every dashboard visit', () => {
    localStorage.setItem('igo-floating-news-gratification-v1', 'seen');

    initFloatingNews();
    vi.advanceTimersByTime(650);

    const root = document.getElementById('igo-floating-news');
    const panel = document.getElementById('floating-news-panel');
    expect(root?.classList.contains('is-open')).toBe(true);
    expect(panel?.getAttribute('aria-hidden')).toBe('false');
    expect(localStorage.getItem('igo-floating-news-gratification-v1')).toBe(
      'seen'
    );
  });

  it('ignores the initial pageshow and reopens slide zero after bfcache restore', () => {
    initFloatingNews();

    dispatchPageShow(false);
    vi.advanceTimersByTime(649);
    expect(
      document
        .getElementById('igo-floating-news')
        ?.classList.contains('is-open')
    ).toBe(false);

    vi.advanceTimersByTime(1);
    document.getElementById('floating-news-next')?.click();
    document.getElementById('floating-news-close')?.click();
    expect(document.getElementById('floating-news-position')?.textContent).toBe(
      '2 / 3'
    );

    dispatchPageShow(true);

    expect(
      document
        .getElementById('igo-floating-news')
        ?.classList.contains('is-open')
    ).toBe(true);
    expect(document.getElementById('floating-news-position')?.textContent).toBe(
      '1 / 3'
    );
  });

  it('does not auto-open on a tool page and keeps the floating action usable', () => {
    window.history.replaceState({}, '', '/compress-pdf');
    initFloatingNews();
    dispatchPageShow(true);
    vi.advanceTimersByTime(650);

    const root = document.getElementById('igo-floating-news');
    const toggle = document.getElementById('floating-news-toggle');
    const close = document.getElementById('floating-news-close');
    const panel = document.getElementById('floating-news-panel');

    expect(root?.classList.contains('is-open')).toBe(false);
    toggle?.click();
    expect(root?.classList.contains('is-open')).toBe(true);
    expect(panel?.getAttribute('aria-hidden')).toBe('false');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    close?.click();
    expect(root?.classList.contains('is-open')).toBe(false);
    expect(panel?.getAttribute('aria-hidden')).toBe('true');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('returns safely when the floating action markup is absent', () => {
    document.body.innerHTML = '';
    expect(() => initFloatingNews()).not.toThrow();
  });
});
