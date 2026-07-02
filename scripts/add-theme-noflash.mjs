// Insert the no-flash theme snippet right after <head> in each given HTML file.
// Idempotent: skips files that already reference 'igo-theme'. Usage:
//   node scripts/add-theme-noflash.mjs <files...>
import { readFile, writeFile } from 'node:fs/promises';
import { THEME_NOFLASH_JS } from './theme-noflash.mjs';

const SNIPPET = `    <script>${THEME_NOFLASH_JS}</script>`;

let changed = 0;
let skipped = 0;
for (const file of process.argv.slice(2)) {
  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  if (html.includes('igo-theme')) {
    skipped++;
    continue;
  }
  const marker = '<head>';
  const idx = html.indexOf(marker);
  if (idx === -1) {
    skipped++;
    continue;
  }
  const at = idx + marker.length;
  html = `${html.slice(0, at)}\n${SNIPPET}${html.slice(at)}`;
  await writeFile(file, html);
  changed++;
}
console.log(`no-flash inserted: changed ${changed}, skipped ${skipped}`);
