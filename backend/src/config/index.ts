import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const sessionSecret = process.env.SESSION_SECRET || 'change-me-in-production';

if (
  nodeEnv === 'production' &&
  (sessionSecret === 'change-me-in-production' || sessionSecret.length < 32)
) {
  throw new Error(
    'SESSION_SECRET must be set to a strong value with at least 32 characters in production'
  );
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'igopdf',
    user: process.env.DB_USER || 'igopdf',
    password: process.env.DB_PASSWORD || 'igopdf_password',
  },
  
  session: {
    secret: sessionSecret,
    timeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || '3', 10),
    cookieName: 'igo_session',
    // Defaults to secure cookies in production, but can be explicitly
    // overridden (e.g. for internal HTTP-only deployments without TLS).
    cookieSecure:
      process.env.SESSION_COOKIE_SECURE !== undefined
        ? process.env.SESSION_COOKIE_SECURE === 'true'
        : nodeEnv === 'production',
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  
  captcha: {
    expiryMinutes: parseInt(process.env.CAPTCHA_EXPIRY_MINUTES || '5', 10),
    width: 150,
    height: 50,
  },
  
  auth: {
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '15', 10),
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;

export type Config = typeof config;
