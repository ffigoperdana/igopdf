import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync(resolve(__dirname, '../css/styles.css'), 'utf8');
const floatingNewsCss = readFileSync(
  resolve(__dirname, '../css/floating-news.css'),
  'utf8'
);
const floatingNewsMarkup = readFileSync(
  resolve(__dirname, '../partials/floating-news.html'),
  'utf8'
);
const authGuardSource = readFileSync(
  resolve(__dirname, '../js/auth/guard.ts'),
  'utf8'
);
const dashboardHtml = readFileSync(
  resolve(__dirname, '../../index.html'),
  'utf8'
);

function extractBlock(source: string, selector: RegExp): string {
  const match = selector.exec(source);
  if (!match) {
    throw new Error(`Expected block matching ${selector}`);
  }

  const openingBrace = source.indexOf('{', match.index);
  if (openingBrace < 0) {
    throw new Error(`Expected opening brace after ${selector}`);
  }

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error(`Expected closing brace after ${selector}`);
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('theme visual contracts', () => {
  it('keeps active navigation and orange authentication actions white', () => {
    const activeNav = extractBlock(
      stylesCss,
      /\.nav-item\.is-active,\s*\.nav-item\.is-active:hover\s*\{/
    );
    const activeNavBackground = extractBlock(
      stylesCss,
      /\.nav-item\.is-active::before\s*\{/
    );
    const authButtonClasses = authGuardSource.match(
      /const btnCls\s*=\s*'([^']+)'/
    )?.[1];

    expect(compact(activeNav)).toContain('color: #ffffff;');
    expect(compact(activeNavBackground)).toContain(
      'background-color: var(--color-vibrant-palm);'
    );
    expect(authButtonClasses).toBeDefined();
    expect(authButtonClasses?.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-vibrant-palm', 'text-white'])
    );
    expect(authButtonClasses).not.toContain('text-ink-slate');
  });

  it('keeps the Info IGO FAB label and icons white on its orange surface', () => {
    const floatingRoot = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news\s*\{/
    );
    const fab = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__fab\s*\{/
    );

    const floatingNewsDocument = new DOMParser().parseFromString(
      floatingNewsMarkup,
      'text/html'
    );
    const fabElement = floatingNewsDocument.getElementById(
      'floating-news-toggle'
    );

    expect(compact(floatingRoot)).toContain(
      '--floating-news-fab-bg: var(--color-vibrant-palm, #e67e22);'
    );
    expect(compact(floatingRoot)).toContain(
      '--floating-news-fab-hover: var(--color-palm-700, #c96812);'
    );
    expect(compact(fab)).toContain('background: var(--floating-news-fab-bg);');
    expect(compact(fab)).toContain('color: #fff;');
    expect(
      fabElement?.querySelector('.floating-news__fab-label')
    ).not.toBeNull();
    expect(fabElement?.querySelectorAll('[data-lucide]')).toHaveLength(2);
  });

  it('uses a green white-text header over a white light-mode panel body', () => {
    const floatingRoot = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news\s*\{/
    );
    const panel = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__panel\s*\{/
    );
    const header = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__panel-header\s*\{/
    );
    const headerClose = extractBlock(
      floatingNewsCss,
      /\.floating-news__panel-header\s+\.floating-news__icon-button\s*\{/
    );

    expect(compact(floatingRoot)).toContain(
      '--floating-news-bg: var(--color-surface-raised, #fff);'
    );
    expect(compact(floatingRoot)).toContain(
      '--floating-news-fg: var(--color-content, #111827);'
    );
    expect(compact(floatingRoot)).toContain(
      '--floating-news-header-bg: var(--color-deep-forest, #1f5630);'
    );
    expect(compact(floatingRoot)).toContain('--floating-news-header-fg: #fff;');
    expect(compact(panel)).toContain('background: var(--floating-news-bg);');
    expect(compact(header)).toContain(
      'background: var(--floating-news-header-bg);'
    );
    expect(compact(header)).toContain('color: var(--floating-news-header-fg);');
    expect(compact(headerClose)).toContain(
      'color: var(--floating-news-header-fg);'
    );
  });

  it('uses a deep-green dark panel with a gold border and focus accents', () => {
    const darkRoot = extractBlock(
      floatingNewsCss,
      /\.dark \.floating-news\s*\{/
    );
    const panel = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__panel\s*\{/
    );
    const iconFocus = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__icon-button:focus-visible:not\(:disabled\)\s*\{\s*outline:/
    );

    expect(compact(darkRoot)).toContain(
      '--floating-news-bg: color-mix( in srgb, var(--color-deep-forest, #1f5630) 93%, #071b12 );'
    );
    expect(compact(darkRoot)).toContain('--floating-news-fg: #f3fbf6;');
    expect(compact(darkRoot)).toContain('--floating-news-muted: #c8ddcf;');
    expect(compact(darkRoot)).toContain('--floating-news-border: #d6a431;');
    expect(compact(darkRoot)).toContain('--floating-news-accent: #ffc46b;');
    expect(compact(panel)).toContain(
      'border: 1px solid var(--floating-news-border);'
    );
    expect(compact(iconFocus)).toContain(
      'outline: 3px solid var(--floating-news-accent);'
    );
  });

  it('stacks back-to-top above the FAB and removes it while the panel is open', () => {
    const floatingRoot = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news\s*\{/
    );
    const fab = extractBlock(
      floatingNewsCss,
      /(?:^|\n)\.floating-news__fab\s*\{/
    );
    const backToTop = extractBlock(stylesCss, /#scroll-to-top-btn\s*\{/);
    const openPanelGuard = extractBlock(
      stylesCss,
      /body:has\(\.floating-news\.is-open\) #scroll-to-top-btn\s*\{/
    );
    const mobileFloatingStyles = extractBlock(
      floatingNewsCss,
      /@media \(max-width: 640px\)\s*\{/
    );
    const mobileFloating = extractBlock(
      mobileFloatingStyles,
      /\.floating-news\s*\{/
    );
    const mobileDashboardStyles = extractBlock(
      stylesCss,
      /@media \(max-width: 640px\)\s*\{/
    );
    const mobileBackToTop = extractBlock(
      mobileDashboardStyles,
      /#scroll-to-top-btn\s*\{/
    );
    const buttonClasses = dashboardHtml.match(
      /id="scroll-to-top-btn"\s+class="([^"]+)"/
    )?.[1];

    expect(compact(floatingRoot)).toContain(
      'right: max(1rem, env(safe-area-inset-right));'
    );
    expect(compact(floatingRoot)).toContain(
      'bottom: max(1rem, env(safe-area-inset-bottom));'
    );
    expect(compact(floatingRoot)).toContain('gap: 0.75rem;');
    expect(compact(fab)).toContain('min-height: 3rem;');
    expect(compact(backToTop)).toContain(
      'right: max(1rem, env(safe-area-inset-right));'
    );
    expect(compact(backToTop)).toContain(
      'bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 3.75rem);'
    );
    expect(compact(backToTop)).toContain('transform: translateY(1.5rem);');
    expect(compact(openPanelGuard)).toContain('visibility: hidden;');
    expect(compact(openPanelGuard)).toContain('pointer-events: none;');
    expect(compact(openPanelGuard)).toContain('opacity: 0;');
    expect(compact(mobileFloating)).toContain(
      'right: max(0.75rem, env(safe-area-inset-right));'
    );
    expect(compact(mobileBackToTop)).toContain(
      'right: max(0.75rem, env(safe-area-inset-right));'
    );
    expect(compact(mobileBackToTop)).toContain(
      'bottom: calc(max(0.75rem, env(safe-area-inset-bottom)) + 3.75rem);'
    );
    expect(buttonClasses?.split(/\s+/)).toContain('z-50');
    expect(buttonClasses).not.toMatch(/\b(?:bottom|right)-/);
    expect(buttonClasses).not.toContain('translate-y-6');
  });
});
