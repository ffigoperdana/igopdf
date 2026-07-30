// Insert or normalize the no-flash theme snippet in every app HTML file.
// With --check this becomes a build guard: source pages must contain the exact
// canonical bytes whose hash is allowed by the production CSP.
//
// Usage:
//   node scripts/add-theme-noflash.mjs [--check] [files...]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_NOFLASH_JS } from './theme-noflash.mjs';

const SNIPPET = `    <!-- prettier-ignore -->
    <script>${THEME_NOFLASH_JS}</script>`;
const SCRIPT_RE =
  /[ \t]*(?:<!-- prettier-ignore -->[ \t]*\r?\n[ \t]*)?<script>(?:(?!<\/script>)[\s\S])*?igo-theme(?:(?!<\/script>)[\s\S])*?<\/script>/g;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceHtmlFiles() {
  const files = [];
  for (const entry of await readdir(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(join(repoRoot, entry.name));
    }
  }
  const pagesDir = join(repoRoot, 'src', 'pages');
  for (const entry of await readdir(pagesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(join(pagesDir, entry.name));
    }
  }
  return files;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requestedFiles = args.filter((arg) => arg !== '--check');
const files =
  requestedFiles.length > 0
    ? requestedFiles.map((file) => join(process.cwd(), file))
    : await sourceHtmlFiles();

let changed = 0;
let skipped = 0;
const invalid = [];
for (const file of files) {
  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch {
    continue;
  }

  const originalHtml = html;
  html = html.replace(
    /(<head(?:\s[^>]*)?>\r?\n)(?:[ \t]*\r?\n)+(?=[ \t]*<!-- prettier-ignore -->)/,
    '$1'
  );
  const matches = html.match(SCRIPT_RE) ?? [];
  const canonical = `<!-- prettier-ignore -->
    <script>${THEME_NOFLASH_JS}</script>`;
  if (
    matches.length === 1 &&
    matches[0].trim() === canonical &&
    html === originalHtml
  ) {
    skipped++;
    continue;
  }

  if (checkOnly) {
    invalid.push(file);
    continue;
  }

  if (matches.length > 0) {
    html = html.replace(SCRIPT_RE, SNIPPET);
  } else {
    const marker = '<head>';
    const idx = html.indexOf(marker);
    if (idx === -1) {
      skipped++;
      continue;
    }
    const at = idx + marker.length;
    html = `${html.slice(0, at)}\n${SNIPPET}${html.slice(at)}`;
  }

  // Multiple theme bootstraps would race and make the CSP check ambiguous.
  if ((html.match(SCRIPT_RE) ?? []).length !== 1) {
    invalid.push(file);
    skipped++;
    continue;
  }

  await writeFile(file, html);
  changed++;
}

if (invalid.length > 0) {
  console.error(
    `Theme no-flash snippet is missing, duplicated, or not canonical:\n${invalid.join('\n')}`
  );
  process.exitCode = 1;
} else if (checkOnly) {
  console.log(`theme no-flash check passed: ${skipped} HTML files`);
} else {
  console.log(
    `theme no-flash normalized: changed ${changed}, unchanged ${skipped}`
  );
}
