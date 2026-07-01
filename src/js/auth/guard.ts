import { getCurrentUser, logout, isAdmin } from './session.js';

let currentUser: { id: string; username: string; role: string } | null = null;

export async function initAuth(): Promise<void> {
  currentUser = await getCurrentUser();
  updateUI();
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

  if (currentUser) {
    const adminLinkDesktop = isAdmin(currentUser)
      ? '<a href="/admin.html" class="text-white hover:text-vibrant-palm text-sm font-medium">Admin</a>'
      : '';
    const adminLinkMobile = isAdmin(currentUser)
      ? '<a href="/admin.html" class="block px-3 py-2 text-white hover:text-vibrant-palm">Admin</a>'
      : '';

    const desktopHTML = `
      ${adminLinkDesktop}
      <a href="/profile.html" class="text-white hover:text-vibrant-palm text-sm font-medium">Hello, ${currentUser.username}</a>
      <button id="logout-btn" class="bg-vibrant-palm hover:bg-orange-600 text-white px-4 py-2 rounded text-sm font-medium transition-colors">Logout</button>
    `;

    const mobileHTML = `
      ${adminLinkMobile}
      <a href="/profile.html" class="block px-3 py-2 text-white hover:text-vibrant-palm">Profile</a>
      <button id="logout-btn-mobile" class="block w-full text-left px-3 py-2 text-white hover:text-vibrant-palm">Logout</button>
    `;

    if (authArea) authArea.innerHTML = desktopHTML;
    if (authAreaMobile) authAreaMobile.innerHTML = `<span class="text-white text-sm">${currentUser.username}</span>`;
    if (mobileAuthMenu) mobileAuthMenu.innerHTML = mobileHTML;

    document.getElementById('logout-btn')?.addEventListener('click', () => logout());
    document.getElementById('logout-btn-mobile')?.addEventListener('click', () => logout());
  } else {
    const loginHTML = '<a href="/login.html" class="bg-vibrant-palm hover:bg-orange-600 text-white px-4 py-2 rounded text-sm font-medium transition-colors">Login</a>';
    
    if (authArea) authArea.innerHTML = loginHTML;
    if (authAreaMobile) authAreaMobile.innerHTML = '';
    if (mobileAuthMenu) mobileAuthMenu.innerHTML = `<a href="/login.html" class="block px-3 py-2 text-white hover:text-vibrant-palm">Login</a>`;
  }
}
