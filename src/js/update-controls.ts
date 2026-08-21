import { showAlert } from './ui.js';
import { t } from './i18n/i18n.js';
import {
  applyAvailableUpdate,
  checkForUpdates,
  consumeUpdateNotice,
  type ManualUpdateResult,
} from './sw-register.js';

let controlsInitialized = false;

function translate(key: string, fallback: string): string {
  try {
    const value = t(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function notify(title: string, message: string, type = 'success'): void {
  if (document.getElementById('alert-modal')) {
    showAlert(title, message, type);
    return;
  }

  window.alert(`${title}\n\n${message}`);
}

function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button
    .querySelector<SVGElement>('.update-check-icon')
    ?.classList.toggle('animate-spin', busy);
}

function showResult(result: ManualUpdateResult): void {
  switch (result.status) {
    case 'available': {
      const shouldApply = window.confirm(
        translate(
          'nav.updateAvailable',
          'A new IGO version is available. Reload now? Save any unfinished work first.'
        )
      );
      if (shouldApply && applyAvailableUpdate(result.registration)) {
        notify(
          translate('nav.checkForUpdates', 'Check for updates'),
          translate(
            'nav.updateApplying',
            'Applying the update. This page will reload.'
          )
        );
      }
      return;
    }
    case 'preparing':
      notify(
        translate('nav.checkForUpdates', 'Check for updates'),
        translate(
          'nav.updatePreparing',
          'An update was found and is still being prepared. Try again in a moment.'
        )
      );
      return;
    case 'up-to-date':
      notify(
        translate('nav.checkForUpdates', 'Check for updates'),
        translate('nav.upToDate', 'IGO is already up to date.')
      );
      return;
    case 'unsupported':
      notify(
        translate('nav.checkForUpdates', 'Check for updates'),
        translate(
          'nav.updateUnsupported',
          'Update checks are not available in this browser.'
        ),
        'error'
      );
      return;
    case 'error':
      notify(
        translate('nav.checkForUpdates', 'Check for updates'),
        translate(
          'nav.updateCheckFailed',
          'The update check failed. Please try again later.'
        ),
        'error'
      );
      return;
  }
}

async function checkManually(button: HTMLButtonElement): Promise<void> {
  setButtonBusy(button, true);
  try {
    showResult(await checkForUpdates());
  } finally {
    setButtonBusy(button, false);
  }
}

export function initUpdateControls(): void {
  if (controlsInitialized) return;
  controlsInitialized = true;

  document
    .querySelectorAll<HTMLButtonElement>(
      '#check-updates-btn, #check-updates-btn-mobile'
    )
    .forEach((button) => {
      button.addEventListener('click', () => void checkManually(button));
    });

  if (consumeUpdateNotice()) {
    window.setTimeout(() => {
      notify(
        translate('nav.checkForUpdates', 'Check for updates'),
        translate(
          'nav.updateComplete',
          'IGO has been updated to the latest version.'
        )
      );
    }, 0);
  }
}
