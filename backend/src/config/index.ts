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

  // Reverse-proxy hops in front of this app (compose nginx = 1; WAF + nginx = 2).
  // Drives Express `trust proxy`, which resolves req.ip from X-Forwarded-For.
  // If this is lower than the real hop count (or the proxy doesn't send XFF),
  // every user resolves to the proxy's IP and all per-IP rate limits pool into
  // one shared bucket — one person's failures then block the whole office.
  // Guarded: a typo'd value would parse to NaN, which Express treats as
  // "trust nothing" — silently reintroducing exactly that pooling bug.
  trustProxyHops: (() => {
    const hops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
    return Number.isInteger(hops) && hops >= 0 ? hops : 1;
  })(),

  captcha: {
    expiryMinutes: parseInt(process.env.CAPTCHA_EXPIRY_MINUTES || '5', 10),
    width: 150,
    height: 50,
  },

  auth: {
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '15', 10),
  },

  // Active Directory / LDAP single sign-on. When enabled, an AD user who logs
  // in with valid directory credentials is auto-provisioned locally with
  // role 'user' (see authService.ts). Local accounts (the seeded admin, etc.)
  // are unaffected and always authenticate against their stored password_hash.
  ldap: {
    enabled: process.env.LDAP_ENABLED === 'true',
    url: process.env.LDAP_URL || '',
    // Service/bind account used only to search the directory for the DN
    // matching the submitted username. Should be a dedicated read-only
    // service account, not a personal admin account, so login doesn't break
    // if that person's password rotates or their account is disabled.
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    baseDn: process.env.LDAP_BASE_DN || '',
    loginField: process.env.LDAP_LOGIN_FIELD || 'sAMAccountName',
    timeoutMs: parseInt(process.env.LDAP_TIMEOUT_MS || '5000', 10),
    // TLS, only used when LDAP_URL is ldaps://. rejectUnauthorized defaults to
    // true (verify the DC cert). Set LDAP_TLS_REJECT_UNAUTHORIZED=false for an
    // internal self-signed AD cert, or set LDAP_TLS_CA_FILE to the internal CA
    // cert path (mounted into the container) to verify it properly.
    tlsRejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
    tlsCaFile: process.env.LDAP_TLS_CA_FILE || '',
    // Minimum TLS version for ldaps:// connections (e.g. 'TLSv1', 'TLSv1.2').
    // Empty = Node default (TLS 1.2+). Set 'TLSv1' for legacy AD DCs that only
    // offer TLS 1.0/1.1 on LDAPS — Node otherwise resets the handshake
    // (ECONNRESET) even though `ldapsearch`/OpenSSL would connect.
    tlsMinVersion: process.env.LDAP_TLS_MIN_VERSION || '',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;

export type Config = typeof config;
