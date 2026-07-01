import crypto from 'crypto';
import { pool } from '../config/database.js';
import { sessionConfig } from '../config/session.js';
import { config } from '../config/index.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
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
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  last_login AS "lastLogin",
  created_by AS "createdBy"
`;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function login(
  username: string,
  password: string,
  ipAddress: string,
  userAgent: string
): Promise<LoginResult> {
  const userResult = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE username = $1`,
    [username]
  );

  if (userResult.rows.length === 0) {
    await recordLoginAttempt(username, ipAddress, false);
    return { success: false, error: 'Invalid username or password' };
  }

  const user = userResult.rows[0];

  if (!user.isActive) {
    await recordLoginAttempt(username, ipAddress, false);
    return { success: false, error: 'Account is deactivated' };
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    await recordLoginAttempt(username, ipAddress, false);
    return { success: false, error: 'Invalid username or password' };
  }

  await pool.query(
    `UPDATE users SET last_login = NOW() WHERE id = $1`,
    [user.id]
  );

  const session = await createSession(user.id, ipAddress, userAgent);

  await recordLoginAttempt(username, ipAddress, true);

  logger.info('User logged in', { userId: user.id, username: user.username });

  return {
    success: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLogin: user.lastLogin,
      createdBy: user.createdBy,
    },
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

export async function getRecentLoginAttempts(
  username: string,
  ipAddress: string,
  minutes: number = 15
): Promise<{ count: number; lastAttempt: Date | null }> {
  const result = await pool.query(
    `SELECT COUNT(*) as count, MAX(attempted_at) as last_attempt
     FROM login_attempts
     WHERE (username = $1 OR ip_address = $2)
       AND attempted_at > NOW() - ($3::int * INTERVAL '1 minute')
       AND success = false`,
    [username, ipAddress, minutes]
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
