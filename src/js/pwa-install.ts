// One-time PWA install prompt.
//
// Shown EXACTLY ONCE, ever, after the user's first login on this browser, then
// never again (tracked with a localStorage flag set the moment it's shown).
// Supports Android/Windows/desktop Chrome+Edge via the native
// `beforeinstallprompt` event, and iOS Safari via Add-to-Home-Screen steps
// (iOS has no install event). Silently does nothing if the app is already
// installed (running standalone) or the browser can't install it.

const FLAG = 'igo-pwa-prompted';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let armed = false;

// Capture the install event as early as this module evaluates. On Chromium it
// re-fires on navigation, so it's still caught even though the login page
// (which doesn't load this module) missed the first one.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  if (armed) maybeShow();
});

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as a Mac; distinguish by touch support.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

// Call once the user is confirmed logged in (after the auth-guard reveal).
export function initPwaInstallPrompt(): void {
  if (localStorage.getItem(FLAG)) return;
  if (isStandalone()) {
    localStorage.setItem(FLAG, '1'); // already installed → nothing to prompt
    return;
  }
  armed = true;
  maybeShow(); // if beforeinstallprompt already fired, show now
  if (isIos()) window.setTimeout(maybeShow, 1200); // iOS has no event
}

function maybeShow(): void {
  if (!armed || localStorage.getItem(FLAG) || isStandalone()) return;
  const ios = isIos();
  if (!deferred && !ios) return; // wait for the install event (or nothing to show)
  localStorage.setItem(FLAG, '1'); // truly once — set before rendering
  renderModal(ios);
}

function renderModal(ios: boolean): void {
  const overlay = document.createElement('div');
  overlay.className =
    'fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 sm:items-center';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Pasang igo');

  const close = (): void => overlay.remove();

  const iosSteps = `
    <ol class="mt-4 space-y-2 text-sm text-content-muted">
      <li class="flex items-start gap-2"><span class="font-semibold text-vibrant-palm">1.</span> Ketuk ikon <strong class="text-content">Bagikan</strong> di Safari.</li>
      <li class="flex items-start gap-2"><span class="font-semibold text-vibrant-palm">2.</span> Pilih <strong class="text-content">Tambah ke Layar Utama</strong>.</li>
    </ol>`;

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl border border-line bg-surface-raised p-6 shadow-2xl">
      <div class="flex items-center gap-3">
        <img src="${import.meta.env.BASE_URL}images/favicon.svg" alt="" class="h-11 w-11" />
        <div>
          <h3 class="text-lg font-bold text-content">Pasang igo</h3>
          <p class="text-xs text-content-muted">Akses cepat dari layar utama</p>
        </div>
      </div>
      <p class="mt-4 text-sm text-content-muted">
        Pasang igo sebagai aplikasi agar bisa dibuka langsung dari perangkat Anda, layaknya aplikasi biasa — lebih cepat dan tanpa membuka browser.
      </p>
      ${ios ? iosSteps : ''}
      <div class="mt-6 flex gap-3">
        <button type="button" data-pwa-dismiss class="flex-1 rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-content-muted transition-colors hover:text-content">Nanti saja</button>
        ${
          ios
            ? ''
            : '<button type="button" data-pwa-install class="flex-1 rounded-lg bg-vibrant-palm px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-palm-700">Pasang</button>'
        }
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay
    .querySelector('[data-pwa-dismiss]')
    ?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay
    .querySelector('[data-pwa-install]')
    ?.addEventListener('click', async () => {
      close();
      if (!deferred) return;
      try {
        await deferred.prompt();
        await deferred.userChoice;
      } catch {
        /* user dismissed the native prompt — nothing to do */
      }
      deferred = null;
    });
}
