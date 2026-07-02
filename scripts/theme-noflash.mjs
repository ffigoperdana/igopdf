// Single source of truth for the no-flash theme snippet.
//
// Imported by add-theme-noflash.mjs (which injects it into every page <head>)
// AND by generate-security-headers.mjs (which emits its CSP sha256 hash), so
// the hash can never drift from the actual script. The production CSP has no
// 'unsafe-inline', so without this hash the inline snippet is silently blocked
// and dark-mode users get a light flash until the JS bundle's initTheme() runs.
//
// Keep this a single line: the CSP hash is over the exact bytes placed between
// <script> and </script>, and Vite passes non-module inline scripts through
// verbatim, so the built output must equal this string exactly.
export const THEME_NOFLASH_JS =
  "try{var __t=localStorage.getItem('igo-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(__t==='dark')document.documentElement.classList.add('dark');}catch(e){}";
