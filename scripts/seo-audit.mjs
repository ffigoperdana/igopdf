import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// An optional output directory lets policy regression tests use disposable fixtures.
const DIST_DIR = path.resolve(process.argv[2] || path.resolve(__dirname, '../dist'));
const LOCALES_DIR = path.resolve(__dirname, '../public/locales');
const SITE_URL = (process.env.SITE_URL || 'https://igo.bpdp.or.id').replace(
  /\/+$/,
  ''
);
const HOST = new URL(SITE_URL).hostname;

// IGO deliberately excludes these internal pages from indexing. Require their
// noindex directives rather than treating them as public marketing pages.
const NOINDEX_ALLOWLIST = new Set([
  '404.html', 'wasm-settings.html', 'index.html', 'about.html', 'privacy.html',
  'licensing.html', 'login.html', 'profile.html', 'admin.html', 'report.html',
  'guide.html', 'aduan.html', 'admin-guide.html', 'admin-aduan.html',
]);
const SKIP_DIRS = new Set([
  'assets',
  'docs',
  'pdfjs-viewer',
  'pdfjs-annotation-viewer',
]);
const SITEMAP_FORBIDDEN_PATTERNS = [/\/404(\b|\/)/, /index\.html(?:$|\?)/];
const SITEMAP_MAX_URLS = 50000;

const failures = [];
const warnings = [];

function fail(rule, detail) {
  failures.push({ rule, detail });
}

function warn(rule, detail) {
  warnings.push({ rule, detail });
}

function listDistHtml() {
  const files = [];
  function walk(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.posix.join(prefix, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
        walk(full, rel);
      } else if (entry.endsWith('.html')) {
        files.push({ full, rel });
      }
    }
  }
  walk(DIST_DIR);
  return files;
}

function findOne(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function findAll(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) out.push(m[1]);
  return out;
}

function expectedCanonicalForFile(rel) {
  const parts = rel.split('/');
  const fileName = parts.pop();
  const baseName = fileName.replace(/\.html$/, '');
  const slug = baseName === 'index' ? '' : baseName;
  const segments = [SITE_URL];
  if (slug) segments.push(slug);
  return segments.join('/').replace(/\/+$/, '') || SITE_URL;
}

function auditHtml(file) {
  const html = fs.readFileSync(file.full, 'utf-8');
  const titles = findAll(html, /<title[^>]*>[\s\S]*?<\/title>/g);
  if (titles.length === 0) {
    fail('title', `${file.rel}: no <title>`);
  } else if (titles.length > 1) {
    fail('title', `${file.rel}: ${titles.length} <title> tags (expected 1)`);
  }

  const canonicals = findAll(
    html,
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/g
  );
  if (canonicals.length === 0 && !NOINDEX_ALLOWLIST.has(file.rel)) {
    fail('canonical', `${file.rel}: missing <link rel="canonical">`);
  } else if (canonicals.length > 1) {
    fail(
      'canonical',
      `${file.rel}: ${canonicals.length} canonical tags (expected 1)`
    );
  } else if (canonicals.length === 1) {
    const actual = canonicals[0];
    if (file.rel !== '404.html' && actual.endsWith('.html')) {
      fail(
        'canonical',
        `${file.rel}: canonical "${actual}" still ends in .html`
      );
    }
    try {
      const url = new URL(actual);
      if (url.hostname !== HOST) {
        warn(
          'canonical',
          `${file.rel}: canonical host "${url.hostname}" != expected "${HOST}"`
        );
      }
    } catch {
      fail(
        'canonical',
        `${file.rel}: canonical "${actual}" is not a valid URL`
      );
    }
    if (file.rel !== '404.html') {
      const expected = expectedCanonicalForFile(file.rel);
      if (actual.replace(/\/+$/, '') !== expected.replace(/\/+$/, '')) {
        fail(
          'canonical',
          `${file.rel}: canonical "${actual}" != expected "${expected}"`
        );
      }
    }
  }

  const robots = findOne(
    html,
    /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i
  );
  if (
    robots &&
    /noindex/i.test(robots) &&
    !NOINDEX_ALLOWLIST.has(file.rel)
  ) {
    fail(
      'robots',
      `${file.rel}: unexpected noindex directive (robots="${robots}")`
    );
  }

  if (NOINDEX_ALLOWLIST.has(file.rel) && (!robots || !/\bnoindex\b/i.test(robots))) {
    fail('robots', `${file.rel}: required internal-page noindex directive missing`);
  }

  const emptyI18n = html.match(/<span[^>]*data-i18n="[^"]+"[^>]*>\s*<\/span>/g);
  if (emptyI18n && emptyI18n.length > 0) {
    fail(
      'data-i18n',
      `${file.rel}: ${emptyI18n.length} empty data-i18n spans (e.g. ${emptyI18n[0].slice(0, 80)})`
    );
  }

  const aggregateRating = html.includes('"aggregateRating"');
  if (aggregateRating) {
    fail('aggregateRating', `${file.rel}: contains aggregateRating JSON-LD`);
  }

  const hreflangTags = [
    ...html.matchAll(
      /<link[^>]+rel=["']alternate["'][^>]*hreflang=["'][^"']+["'][^>]*>/g
    ),
  ].map((m) => m[0]);
  for (const tag of hreflangTags) {
    const m = tag.match(/href=["']([^"']+)["']/);
    if (!m) continue;
    try {
      const url = new URL(m[1]);
      if (url.hostname !== HOST) {
        fail(
          'hreflang',
          `${file.rel}: hreflang href host "${url.hostname}" != expected "${HOST}"`
        );
      }
    } catch {
      fail('hreflang', `${file.rel}: hreflang href "${m[1]}" not a valid URL`);
    }
  }
}

function auditRobots() {
  const robotsPath = path.join(DIST_DIR, 'robots.txt');
  if (!fs.existsSync(robotsPath)) {
    fail('robots', 'dist/robots.txt missing; IGO must disallow crawling');
    return;
  }
  const groups = [];
  let group = { agents: [], rules: [] };
  for (const raw of fs.readFileSync(robotsPath, 'utf-8').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const directive = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (directive === 'user-agent') {
      if (group.rules.length) {
        groups.push(group);
        group = { agents: [], rules: [] };
      }
      group.agents.push(value);
    } else if (directive === 'allow' || directive === 'disallow') {
      group.rules.push({ directive, value });
    }
  }
  if (group.agents.length) groups.push(group);
  if (!groups.some(({ agents }) => agents.includes('*')) || groups.some(({ rules }) =>
    !rules.some(({ directive, value }) => directive === 'disallow' && value === '/') ||
    rules.some(({ directive, value }) => directive === 'allow' && value !== '')
  )) {
    fail('robots', 'IGO must retain Disallow: / for all crawlers without Allow exceptions');
  }
}

function auditSitemap() {
  const sitemapPath = path.join(DIST_DIR, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) {
    // IGO blocks all crawlers and does not generate public language routes.
    // A sitemap is optional; any supplied sitemap is still validated below.
    return;
  }
  const xml = fs.readFileSync(sitemapPath, 'utf-8');
  const locs = findAll(xml, /<loc>([^<]+)<\/loc>/g);

  if (locs.length === 0) fail('sitemap', 'sitemap has no <loc> entries');
  if (locs.length > SITEMAP_MAX_URLS) {
    fail(
      'sitemap',
      `sitemap has ${locs.length} URLs (max ${SITEMAP_MAX_URLS}); split into a sitemap index`
    );
  }

  const seen = new Set();
  for (const loc of locs) {
    if (seen.has(loc)) {
      fail('sitemap', `sitemap has duplicate <loc>: ${loc}`);
    }
    seen.add(loc);

    for (const pattern of SITEMAP_FORBIDDEN_PATTERNS) {
      if (pattern.test(loc)) {
        fail('sitemap', `sitemap contains forbidden URL: ${loc}`);
      }
    }

    try {
      const url = new URL(loc);
      const page = path.posix.basename(url.pathname.replace(/\/+$/, '')) || 'index';
      if (NOINDEX_ALLOWLIST.has(`${page.replace(/\.html$/, '')}.html`)) {
        fail('sitemap', `sitemap exposes an excluded internal page: ${loc}`);
      }
      if (url.hostname !== HOST) {
        fail(
          'sitemap',
          `sitemap URL host "${url.hostname}" != expected "${HOST}" (${loc})`
        );
      }
    } catch {
      fail('sitemap', `sitemap URL is not valid: ${loc}`);
    }
  }

  const expectedLocales = fs
    .readdirSync(LOCALES_DIR)
    .filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory());
  for (const lang of expectedLocales) {
    if (lang === 'en') continue;
    const hreflangPattern = new RegExp(`hreflang="${lang}"`);
    if (!hreflangPattern.test(xml)) {
      warn('sitemap', `sitemap has no hreflang entry for locale "${lang}"`);
    }
  }
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`SEO audit: dist not found at ${DIST_DIR}`);
    process.exit(1);
  }

  const files = listDistHtml();
  if (files.length === 0) {
    fail('audit', 'no HTML files found in dist/');
  }

  for (const file of files) auditHtml(file);
  auditRobots();
  auditSitemap();

  const total = failures.length + warnings.length;
  if (total === 0) {
    console.log(`SEO audit: ${files.length} HTML files passed; IGO metadata and crawl-blocking policy verified.`);
    return;
  }

  if (warnings.length) {
    console.warn(`\nSEO audit warnings (${warnings.length}):`);
    for (const { rule, detail } of warnings.slice(0, 50)) {
      console.warn(`  [${rule}] ${detail}`);
    }
    if (warnings.length > 50) {
      console.warn(`  ... and ${warnings.length - 50} more warnings`);
    }
  }

  if (failures.length) {
    console.error(`\nSEO audit failures (${failures.length}):`);
    for (const { rule, detail } of failures.slice(0, 100)) {
      console.error(`  [${rule}] ${detail}`);
    }
    if (failures.length > 100) {
      console.error(`  ... and ${failures.length - 100} more failures`);
    }
    process.exit(1);
  }
}

main();
