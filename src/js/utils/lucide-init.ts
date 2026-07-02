// Lazy-load lucide so its full icon set is a separate async chunk, keeping it
// out of every page's main bundle (smaller main-thread parse). Icons render a
// tick after DOMContentLoaded; [data-lucide] placeholders reserve their box via
// CSS (i[data-lucide]{display:inline-block}) so there's no layout shift.
document.addEventListener('DOMContentLoaded', () => {
  void import('lucide').then(({ createIcons, icons }) => createIcons({ icons }));
});
