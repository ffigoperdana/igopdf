/**
 * Service Worker Registration
 * Registers the service worker to enable offline caching
 *
 * Note: Service Worker is disabled in development mode to prevent
 * conflicts with Vite's HMR (Hot Module Replacement)
 */

// Skip service worker registration only under the Vite dev server (HMR).
// Production builds — including the Docker image served at localhost:8099 —
// register the SW so the app is installable/offline-capable (PWA).
const isDevelopment = import.meta.env.DEV;
const BUILD_ID = __IGO_BUILD_ID__;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let promptedWorker: ServiceWorker | null = null;
let reloadForUpdate = false;

async function checkDeploymentVersion(): Promise<boolean> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}version.json`, {
      cache: 'no-store',
    });
    if (!response.ok) return false;

    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('buildId' in payload) ||
      typeof payload.buildId !== 'string' ||
      payload.buildId === BUILD_ID
    ) {
      return false;
    }

    console.info('[SW] A newer deployment was detected');
    return true;
  } catch (error) {
    console.warn('[SW] Deployment-version check failed:', error);
    return false;
  }
}

function offerUpdate(worker: ServiceWorker) {
  if (!navigator.serviceWorker.controller || promptedWorker === worker) {
    return;
  }

  promptedWorker = worker;
  console.log('[SW] New version available! Reload to update.');
  if (confirm('A new version of igo is available. Reload to update?')) {
    // Do not reload immediately: the new worker must take control first so
    // the page cannot accidentally boot with an old cache.
    reloadForUpdate = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  }
}

function collectTrustedWasmHosts(): string[] {
  const hosts = new Set<string>();
  const candidates = [
    import.meta.env.VITE_WASM_PYMUPDF_URL,
    import.meta.env.VITE_WASM_GS_URL,
    import.meta.env.VITE_WASM_CPDF_URL,
    import.meta.env.VITE_TESSERACT_WORKER_URL,
    import.meta.env.VITE_TESSERACT_CORE_URL,
    import.meta.env.VITE_TESSERACT_LANG_URL,
    import.meta.env.VITE_OCR_FONT_BASE_URL,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).origin);
    } catch {
      console.warn(
        `[SW] Ignoring malformed VITE_* URL for SW trusted-hosts: ${raw}`
      );
    }
  }
  return Array.from(hosts);
}

function sendTrustedHostsToSw(target: ServiceWorker | null | undefined) {
  if (!target) return;
  const hosts = collectTrustedWasmHosts();
  if (hosts.length === 0) return;
  target.postMessage({ type: 'SET_TRUSTED_CDN_HOSTS', hosts });
}

if (isDevelopment) {
  console.log('[Dev Mode] Service Worker registration skipped in development');
  console.log('Service Worker will be active in production builds');
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swPath = `${import.meta.env.BASE_URL}sw.js`;
    console.log('[SW] Registering Service Worker at:', swPath);
    navigator.serviceWorker
      .register(swPath)
      .then((registration) => {
        console.log(
          '[SW] Service Worker registered successfully:',
          registration.scope
        );

        sendTrustedHostsToSw(
          registration.active || registration.waiting || registration.installing
        );

        const checkForUpdates = async () => {
          const newerDeployment = await checkDeploymentVersion();
          try {
            await registration.update();
            if (registration.waiting) {
              if (newerDeployment) {
                console.info('[SW] A deployment update is ready to apply');
              }
              offerUpdate(registration.waiting);
            }
          } catch (error) {
            console.warn('[SW] Update check failed:', error);
          }
        };

        checkForUpdates();
        window.setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
        window.addEventListener('focus', checkForUpdates);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            checkForUpdates();
          }
        });

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                sendTrustedHostsToSw(newWorker);
              }
              if (
                newWorker.state === 'installed' &&
                navigator.serviceWorker.controller
              ) {
                offerUpdate(newWorker);
              }
            });
          }
        });
      })
      .catch((error) => {
        console.error('[SW] Service Worker registration failed:', error);
      });

    navigator.serviceWorker.ready.then((registration) => {
      sendTrustedHostsToSw(registration.active);
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadForUpdate) {
        console.log('[SW] New service worker activated, reloading...');
        window.location.reload();
      }
    });
  });
}
