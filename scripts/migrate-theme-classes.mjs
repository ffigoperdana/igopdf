// Migrate hardcoded gray/dark utility classes to theme-aware semantic tokens
// so every page flips with `.dark`. Dark token values ≈ the old grays, so dark
// mode is ~unchanged; light mode is the new capability.
//
// - Base gray/slate maps: applied to HTML + TS class strings (context-free, safe).
// - `text-white`: only flipped to `text-content` when the class list has NO
//   colored button bg (bg-palm/red/green/… stay white). HTML only.
//
// Usage: node scripts/migrate-theme-classes.mjs <files...>
import { readFile, writeFile } from 'node:fs/promises';

const BASE = {
  'bg-gray-900': 'bg-surface',
  'bg-gray-850': 'bg-surface-raised',
  'bg-gray-800': 'bg-surface-raised',
  'bg-gray-700': 'bg-surface-muted',
  'bg-gray-600': 'bg-surface-muted',
  'bg-gray-500': 'bg-surface-muted',
  'bg-gray-200': 'bg-surface-muted',
  'bg-gray-100': 'bg-surface-raised',
  'bg-gray-50': 'bg-surface',
  'border-gray-800': 'border-line',
  'border-gray-700': 'border-line',
  'border-gray-600': 'border-line',
  'border-gray-500': 'border-line',
  'border-gray-300': 'border-line',
  'border-gray-200': 'border-line',
  'border-slate-200': 'border-line',
  'text-gray-100': 'text-content',
  'text-gray-200': 'text-content',
  'text-gray-300': 'text-content-muted',
  'text-gray-400': 'text-content-muted',
  'text-gray-500': 'text-content-muted',
  'text-gray-600': 'text-content-muted',
  'text-gray-700': 'text-content',
  'text-gray-800': 'text-content',
  'text-gray-900': 'text-content',
  'placeholder-gray-400': 'placeholder-content-muted',
  'placeholder-gray-500': 'placeholder-content-muted',
  'divide-gray-700': 'divide-line',
  'ring-gray-300': 'ring-line',
  'from-gray-100': 'from-surface-raised',
  'from-gray-50': 'from-surface-raised',
  'to-gray-200': 'to-surface-muted',
  'to-gray-100': 'to-surface-muted',
};

// Fixed brand text tokens that stay in light mode but need a readable dark
// variant appended (they're near-black / dark-green — invisible on a dark bg).
const ADD_DARK = {
  'text-ink-slate': 'text-ink-slate dark:text-content',
  'text-deep-forest': 'text-deep-forest dark:text-content',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// token boundary: not preceded/followed by a word char or hyphen (so `hover:` and
// `/50` are preserved, and `bg-gray-700` inside `bg-gray-7000` never matches).
const boundary = (t) => new RegExp(`(?<![\\w-])${esc(t)}(?![\\w-])`, 'g');
const COMPILED = Object.entries(BASE).map(([f, t]) => [boundary(f), t]);

const COLORED_BG =
  /(?<![\w-])(bg|from|to|via)-(palm|red|green|blue|emerald|orange|amber|yellow|rose|sky|cyan|teal|vibrant-palm|deep-forest)(-\d{2,3})?(\/\d{1,3})?(?![\w-])/;
const TEXT_WHITE = /(?<![\w-])text-white(?![\w-])/g;

function applyBase(text) {
  for (const [re, to] of COMPILED) text = text.replace(re, to);
  return text;
}

// Append a dark: variant to fixed dark-text brand tokens (idempotent: skips a
// token that already has its dark variant right after it).
function applyAddDark(text) {
  for (const [from, to] of Object.entries(ADD_DARK)) {
    const darkVar = to.slice(from.length + 1); // e.g. "dark:text-content"
    // `(?<![\\w-:])` also excludes a preceding ':' so we never match inside an
    // existing variant like `dark:text-ink-slate`.
    const re = new RegExp(`(?<![\\w-:])${esc(from)}(?![\\w-])(?!\\s+${esc(darkVar)})`, 'g');
    text = text.replace(re, to);
  }
  return text;
}

// For HTML: flip text-white->text-content inside class attrs that aren't buttons.
function flipTextWhite(html) {
  return html.replace(/class="([^"]*)"/g, (m, cls) => {
    if (!/text-white/.test(cls)) return m;
    if (COLORED_BG.test(cls)) return m; // button label — keep white
    return `class="${cls.replace(TEXT_WHITE, 'text-content')}"`;
  });
}

let changed = 0;
for (const file of process.argv.slice(2)) {
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  let out = applyBase(src);
  out = applyAddDark(out);
  if (file.endsWith('.html')) out = flipTextWhite(out);
  if (out !== src) {
    await writeFile(file, out);
    changed++;
  }
}
console.log(`theme-class migration: ${changed} files changed`);
