const GRATIFICATION_NOTICE_KEY = 'igo-floating-news-gratification-v1';
const SLIDE_COUNT = 3;

function isHomePage(): boolean {
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  return page === '' || page === 'index.html' || page === 'index';
}

function hasSeenGratificationNotice(): boolean {
  try {
    return localStorage.getItem(GRATIFICATION_NOTICE_KEY) === 'seen';
  } catch {
    return false;
  }
}

function markGratificationNoticeSeen(): void {
  try {
    localStorage.setItem(GRATIFICATION_NOTICE_KEY, 'seen');
  } catch {
    // The panel remains usable when browser storage is unavailable.
  }
}

export function initFloatingNews(): void {
  const root = document.getElementById('igo-floating-news');
  const panel = document.getElementById('floating-news-panel');
  const viewport = root.querySelector<HTMLElement>('.floating-news__viewport');
  const track = document.getElementById('floating-news-track');
  const toggle = document.getElementById('floating-news-toggle');
  const close = document.getElementById('floating-news-close');
  const previous = document.getElementById('floating-news-prev');
  const next = document.getElementById('floating-news-next');
  const position = document.getElementById('floating-news-position');

  if (!root || !panel || !viewport || !track || !toggle || !close || !previous || !next || !position) return;

  const slides = [...track.querySelectorAll<HTMLElement>('.floating-news__slide')];
  if (slides.length !== SLIDE_COUNT) return;

  let activeSlide = 0;
  let isOpen = false;

  const updateSlide = () => {
    track.style.transform = `translateX(-${activeSlide * 100}%)`;
    position.textContent = `${activeSlide + 1} / ${SLIDE_COUNT}`;
    previous.toggleAttribute('disabled', activeSlide === 0);
    next.toggleAttribute('disabled', activeSlide === SLIDE_COUNT - 1);
    viewport.style.height = `${slides[activeSlide].offsetHeight}px`;
  };

  const setOpen = (open: boolean, focusPanel = false) => {
    isOpen = open;
    root.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    toggle.setAttribute('aria-expanded', String(open));
    if (open && focusPanel) close.focus();
  };

  const openAt = (slide: number, focusPanel = false) => {
    activeSlide = Math.max(0, Math.min(slide, SLIDE_COUNT - 1));
    updateSlide();
    setOpen(true, focusPanel);
  };

  toggle.addEventListener('click', () => (isOpen ? setOpen(false) : openAt(activeSlide, true)));
  close.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  previous.addEventListener('click', () => openAt(activeSlide - 1));
  next.addEventListener('click', () => openAt(activeSlide + 1));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (isOpen && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
  });
  document.addEventListener('igo:languagechange', () => window.requestAnimationFrame(updateSlide));
  window.addEventListener('resize', updateSlide);

  updateSlide();
  if (isHomePage() && !hasSeenGratificationNotice()) {
    window.setTimeout(() => {
      openAt(0);
      markGratificationNoticeSeen();
    }, 650);
  }
}
