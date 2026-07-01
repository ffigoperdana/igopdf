import { config } from './index.js';

export const sessionConfig = {
  secret: config.session.secret,
  timeoutMs: config.session.timeoutHours * 60 * 60 * 1000,
  cookieName: config.session.cookieName,
  cookieOptions: {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: config.session.timeoutHours * 60 * 60 * 1000,
  },
} as const;
