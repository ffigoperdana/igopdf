import crypto from 'crypto';
import { pool } from '../config/database.js';
import { sessionConfig } from '../config/session.js';
import { config } from '../config/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { authenticateLdap } from './ldapService.js';
import { logger } from '../utils/logger.js';
import type { User, Session } from '../types/index.js';

interface LoginResult {
  success: boolean;
  user?: Omit<User, 'passwordHash'>;
  session?: Session;
  error?: string;
}

interface AuthenticatedSession {
  id: string;
  user_id: string;
  username: string;
  role: string;
}

const USER_FIELDS = `
  id,
  username,
  password_hash AS "passwordHash",
  role,
  is_active AS "isActive",
  auth_source AS "authSource",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  last_login AS "lastLogin",
  created_by AS "createdBy"
`;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toSafeUser(user: User): Omit<User, 'passwordHash'> {
  const { passwordHash, ...safe } = user;
  return safe;
}

/**
 * Auto-provisions an AD/LDAP user the first time they log in (full SSO model).
 * Their password is never stored (password_hash stays NULL) — it's verified
 * live against the directory on every login. Role defaults to 'user'; admins
 * are always local accounts. ON CONFLICT makes two concurrent first-logins
 * safe and simply returns the existing row.
 */
async function provisionLdapUser(username: string): Promise<User> {
  const result = await pool.query<User>(
    `INSERT INTO users (username, password_hash, role, auth_source)
     VALUES ($1, NULL, 'user', 'ldap')
     ON CONFLICT (username) DO UPDATE SET updated_at = NOW()
     RETURNING ${USER_FIELDS}`,
    [username]
  );
  return result.rows[0];
}

export async function login(
  username: string,
  password: string,
  ipAddress: string,
  userAgent: string
): Promise<LoginResult> {
  const typedUsername = username.trim();

  // Case-insensitive lookup: AD sAMAccountNames are case-insensitive, and this
  // also makes local logins tolerant of capitalization. If a local account
  // ever shares a name with an LDAP one, prefer the local row so LDAP can
  // never shadow a locally-managed (e.g. admin) login.
  const userResult = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE LOWER(username) = LOWER($1)
     ORDER BY (auth_source = 'local') DESC
     LIMIT 1`,
    [typedUsername]
  );

  let user: User | null = userResult.rows[0] ?? null;

  // First-time SSO login: no local row yet. Verify against AD and, if the
  // directory accepts the credentials, create the account on the fly.
  if (!user) {
    if (!config.ldap.enabled) {
      await recordLoginAttempt(typedUsername, ipAddress, false);
      return { success: false, error: 'Invalid username or password' };
    }

    const ldapResult = await authenticateLdap(typedUsername, password);
    if (!ldapResult.success) {
      await recordLoginAttempt(typedUsername, ipAddress, false);
      return { success: false, error: 'Invalid username or password' };
    }

    user = await provisionLdapUser(typedUsername.toLowerCase());

    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [
      user.id,
    ]);
    const session = await createSession(user.id, ipAddress, userAgent);
    await recordLoginAttempt(typedUsername, ipAddress, true);
    await clearFailedLoginAttempts(typedUsername);
    logger.info('LDAP user auto-provisioned on first login', {
      userId: user.id,
      username: user.username,
    });

    return { success: true, user: toSafeUser(user), session };
  }

  if (!user.isActive) {
    await recordLoginAttempt(typedUsername, ipAddress, false);
    return { success: false, error: 'Account is deactivated' };
  }

  // Hybrid auth: users with auth_source='ldap' are verified live against
  // Active Directory; everyone else (including the local admin account) keeps
  // using the locally stored argon2 hash exactly as before.
  const passwordValid =
    user.authSource === 'ldap'
      ? (await authenticateLdap(typedUsername, password)).success
      : user.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : false;

  if (!passwordValid) {
    await recordLoginAttempt(typedUsername, ipAddress, false);
    return { success: false, error: 'Invalid username or password' };
  }

  await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [
    user.id,
  ]);

  const session = await createSession(user.id, ipAddress, userAgent);

  await recordLoginAttempt(typedUsername, ipAddress, true);
  await clearFailedLoginAttempts(typedUsername);

  logger.info('User logged in', { userId: user.id, username: user.username });

  return {
    success: true,
    user: toSafeUser(user),
    session,
  };
}

export async function createSession(
  userId: string,
  ipAddress: string,
  userAgent: string
): Promise<Session> {
  const token = crypto.randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionConfig.timeoutMs);

  const result = await pool.query<Session>(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, tokenHash, ipAddress, userAgent, expiresAt]
  );

  const session = result.rows[0];
  (session as unknown as Record<string, unknown>).token = token;

  return session;
}

export async function getSession(
  token: string
): Promise<AuthenticatedSession | null> {
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `SELECT s.*, u.id as user_id, u.role, u.username
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = true`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function logout(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
  logger.info('User logged out');
}

export async function invalidateUserSessions(userId: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  logger.info('All sessions invalidated for user', { userId });
}

async function recordLoginAttempt(
  username: string,
  ipAddress: string,
  success: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts (username, ip_address, success)
     VALUES ($1, $2, $3)`,
    [username, ipAddress, success]
  );
}

// A successful login resets the account's lockout counter so earlier fat-finger
// failures don't count against the user going forward.
async function clearFailedLoginAttempts(username: string): Promise<void> {
  await pool.query(
    `DELETE FROM login_attempts
     WHERE LOWER(username) = LOWER($1) AND success = false`,
    [username]
  );
}

export async function getRecentLoginAttempts(
  username: string,
  minutes: number = 15
): Promise<{ count: number; lastAttempt: Date | null }> {
  // Count per-USERNAME failures only (no IP term). The per-IP throttle is
  // handled separately by loginLimiter; counting by IP here would let one
  // attacker lock out every user sharing an office NAT / reverse-proxy IP —
  // a real risk for this internal app served behind a single-IP WAF.
  const result = await pool.query(
    `SELECT COUNT(*) as count, MAX(attempted_at) as last_attempt
     FROM login_attempts
     WHERE LOWER(username) = LOWER($1)
       AND attempted_at > NOW() - ($2::int * INTERVAL '1 minute')
       AND success = false`,
    [username, minutes]
  );

  return {
    count: parseInt(result.rows[0].count, 10),
    lastAttempt: result.rows[0].last_attempt,
  };
}

export async function cleanupExpiredSessions(): Promise<void> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE expires_at < NOW()`
  );
  logger.debug(`Cleaned up ${result.rowCount} expired sessions`);
}
