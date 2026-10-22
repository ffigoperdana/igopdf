import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

const script = fileURLToPath(new URL('./seo-audit.mjs', import.meta.url));
const site = 'https://igo.bpdp.or.id';
let directory;

function page({ canonical, robots = 'index, follow', title = '<title>IGO</title>' } = {}) {
  return `<html><head>${title}<meta name="robots" content="${robots}">${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head><body>IGO</body></html>`;
}

function write(name, content) {
  writeFileSync(path.join(directory, name), content);
}

function audit() {
  return spawnSync(process.execPath, [script, directory], {
    encoding: 'utf8',
    env: { ...process.env, SITE_URL: site },
  });
}

function rejected(rule) {
  const result = audit();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(`[${rule}]`), result.stderr);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'igo-seo-audit-'));
  write('robots.txt', 'User-agent: *\nDisallow: /\n');
  write('index.html', page({ canonical: `${site}/`, robots: 'noindex, nofollow' }));
  write('merge-pdf.html', page({ canonical: `${site}/merge-pdf` }));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('accepts IGO metadata with crawl blocking and no public sitemap', () => {
  write('login.html', page({ robots: 'noindex, nofollow' }));
  const result = audit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('rejects a wrong canonical domain even on an excluded page', () => {
  write('index.html', page({ canonical: 'https://igo.local/', robots: 'noindex' }));
  rejected('canonical');
});

test('requires canonicals on tool pages', () => {
  write('merge-pdf.html', page());
  rejected('canonical');
});

test('requires noindex on internal authenticated pages', () => {
  write('admin.html', page());
  rejected('robots');
});

test('rejects an unexpected noindex directive on a tool page', () => {
  write('merge-pdf.html', page({ canonical: `${site}/merge-pdf`, robots: 'noindex' }));
  rejected('robots');
});

test('rejects a missing crawl-blocking robots file', () => {
  rmSync(path.join(directory, 'robots.txt'));
  rejected('robots');
});

test('rejects allow exceptions and crawler-specific overrides', () => {
  for (const robots of [
    'User-agent: *\nDisallow: /\nAllow: /admin\n',
    'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private\n',
  ]) {
    write('robots.txt', robots);
    rejected('robots');
  }
});

test('validates any supplied sitemap without exposing excluded internal pages', () => {
  write('sitemap.xml', `<urlset><url><loc>${site}/login</loc></url></urlset>`);
  rejected('sitemap');
  write('sitemap.xml', '<urlset><url><loc>https://igo.local/merge-pdf</loc></url></urlset>');
  rejected('sitemap');
});

test('keeps duplicate-title, hreflang-host, and structured-rating checks', () => {
  write('merge-pdf.html', page({ canonical: `${site}/merge-pdf`, title: '<title>IGO</title><title>Duplicate</title>' }));
  rejected('title');
  write('merge-pdf.html', `${page({ canonical: `${site}/merge-pdf` })}<link rel="alternate" hreflang="id" href="https://igo.local/id">`);
  rejected('hreflang');
  write('merge-pdf.html', `${page({ canonical: `${site}/merge-pdf` })}<script type="application/ld+json">{"aggregateRating":{}}</script>`);
  rejected('aggregateRating');
});
