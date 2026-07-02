import { getCurrentUser, logout, isAdmin } from './session.js';

let currentUser: { id: string; username: string; role: string } | null = null;
let authPromise: Promise<void> | null = null;

export async function initAuth(): Promise<void> {
  // Memoized: the early auth-gate (main.ts) and init() both await this, but the
  // /auth/me round-trip must happen only once per page load.
  if (!authPromise) {
    authPromise = (async () => {
      currentUser = await getCurrentUser();
      updateUI();
    })();
  }
  return authPromise;
}

export function getUser() {
  return currentUser;
}

export function requireAuth(): void {
  if (!currentUser) {
    window.location.href = '/login.html';
  }
}

export function requireAdmin(): void {
  if (!currentUser || !isAdmin(currentUser)) {
    window.location.href = '/index.html';
  }
}

function updateUI(): void {
  const authArea = document.getElementById('auth-area');
  const authAreaMobile = document.getElementById('auth-area-mobile');
  const mobileAuthMenu = document.getElementById('mobile-auth-menu');

  // Navbar inverts (green→white text in light, white→ink text in dark), so
  // links inherit/flip; the orange button stays the same in both themes.
  const linkCls =
    'text-white hover:text-vibrant-palm text-sm font-medium';
  const btnCls =
    'bg-vibrant-palm hover:bg-palm-700 text-white px-4 py-2 rounded text-sm font-medium transition-colors';

  if (currentUser) {
    const adminLinkDesktop = isAdmin(currentUser)
      ? `<a href="/report.html" class="${linkCls}">Report</a>
         <a href="/admin.html" class="${linkCls}">Admin</a>`
      : '';
    const adminLinkMobile = isAdmin(currentUser)
      ? '<a href="/report.html" class="block px-3 py-2 hover:text-vibrant-palm">Report</a><a href="/admin.html" class="block px-3 py-2 hover:text-vibrant-palm">Admin</a>'
      : '';

    const desktopHTML = `
      ${adminLinkDesktop}
      <a href="/profile.html" class="${linkCls}">Hello, ${currentUser.username}</a>
      <button id="logout-btn" class="${btnCls}">Logout</button>
    `;

    const mobileHTML = `
      ${adminLinkMobile}
      <a href="/profile.html" class="block px-3 py-2 hover:text-vibrant-palm">Profile</a>
      <button id="logout-btn-mobile" class="block w-full text-left px-3 py-2 hover:text-vibrant-palm">Logout</button>
    `;

    if (authArea) authArea.innerHTML = desktopHTML;
    if (authAreaMobile)
      authAreaMobile.innerHTML = `<span class="text-sm text-white">${currentUser.username}</span>`;
    if (mobileAuthMenu) mobileAuthMenu.innerHTML = mobileHTML;

    document.getElementById('logout-btn')?.addEventListener('click', () => logout());
    document.getElementById('logout-btn-mobile')?.addEventListener('click', () => logout());
  } else {
    const loginHTML = `<a href="/login.html" class="${btnCls}">Login</a>`;

    if (authArea) authArea.innerHTML = loginHTML;
    if (authAreaMobile) authAreaMobile.innerHTML = '';
    if (mobileAuthMenu)
      mobileAuthMenu.innerHTML = `<a href="/login.html" class="block px-3 py-2 hover:text-vibrant-palm">Login</a>`;
  }
}
