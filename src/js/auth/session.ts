const API_BASE = '/api';

interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthResponse {
  success: boolean;
  data?: { user: User };
  error?: string;
  code?: string;
}

interface CaptchaResponse {
  success: boolean;
  data?: { token: string; svg: string };
  error?: string;
}

export async function login(
  username: string,
  password: string,
  captchaToken: string,
  captchaAnswer: string
): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password, captchaToken, captchaAnswer }),
  });
  return response.json();
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_AUTH_CACHE' });
  }

  window.location.href = '/login.html';
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    const data = await response.json();
    if (data.success && data.data?.user) {
      return data.data.user;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getCaptcha(): Promise<CaptchaResponse> {
  const response = await fetch(`${API_BASE}/captcha`, {
    credentials: 'include',
  });
  return response.json();
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/users/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return response.json();
}

export function isAdmin(user: User | null): boolean {
  return user?.role === 'admin';
}

export function isAuthenticated(user: User | null): boolean {
  return user !== null;
}
