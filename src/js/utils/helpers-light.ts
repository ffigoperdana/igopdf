// Zero-dependency helpers safe to import from any page — no pdf.js / qpdf /
// lucide — so importing them never drags heavy libraries into a page's bundle
// (notably the homepage). These mirror the same-named exports in helpers.ts
// (which additionally pulls the heavy PDF deps needed for getPDFDocument, etc.).

export const formatBytes = (bytes: number, decimals = 1): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export function formatShortcutDisplay(
  shortcut: string,
  isMac: boolean
): string {
  if (!shortcut) return '';
  return shortcut
    .replace('mod', isMac ? '⌘' : 'Ctrl')
    .replace('ctrl', isMac ? '^' : 'Ctrl')
    .replace('alt', isMac ? '⌥' : 'Alt')
    .replace('shift', 'Shift')
    .split('+')
    .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
    .join(isMac ? '' : '+');
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}
