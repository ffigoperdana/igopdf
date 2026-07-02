import { pool } from '../config/database.js';
import { hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';
import type { User, CreateUserRequest, UpdateUserRequest, DashboardStats } from '../types/index.js';

type SafeUser = Omit<User, 'passwordHash'>;

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

function sanitizeUser(user: User): SafeUser {
  const { passwordHash, ...safe } = user;
  return safe;
}

export async function getUserById(id: string): Promise<SafeUser | null> {
  const result = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE id = $1`,
    [id]
  );
  return result.rows.length > 0 ? sanitizeUser(result.rows[0]) : null;
}

export async function getUserByUsername(username: string): Promise<SafeUser | null> {
  const result = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE username = $1`,
    [username]
  );
  return result.rows.length > 0 ? sanitizeUser(result.rows[0]) : null;
}

export async function listUsers(
  page: number = 1,
  limit: number = 20,
  search?: string,
  role?: string,
  isActive?: boolean
): Promise<{ users: SafeUser[]; total: number }> {
  // Admin user-management is for LOCAL accounts only. LDAP/AD users are pure
  // SSO — they're auto-provisioned on login and governed entirely by Active
  // Directory, so they're intentionally excluded from this list (and its count)
  // to keep the admin panel focused on the accounts it actually manages.
  let whereClause = "WHERE auth_source = 'local'";
  const params: unknown[] = [];
  let paramIndex = 1;

  if (search) {
    whereClause += ` AND username ILIKE $${paramIndex}`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  if (role) {
    whereClause += ` AND role = $${paramIndex}`;
    params.push(role);
    paramIndex++;
  }

  if (isActive !== undefined) {
    whereClause += ` AND is_active = $${paramIndex}`;
    params.push(isActive);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM users ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const result = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  return {
    users: result.rows.map(sanitizeUser),
    total,
  };
}

export async function createUser(
  request: CreateUserRequest,
  createdBy?: string
): Promise<SafeUser> {
  const authSource = request.authSource ?? 'local';

  // LDAP-backed accounts don't store a local password at all — they're
  // verified live against the directory on every login (see authService.ts).
  // Local accounts still need one, same as before this feature existed.
  if (authSource !== 'ldap' && !request.password) {
    throw new Error('Password is required for local accounts');
  }

  // Admins must be local accounts — an LDAP admin would be a hidden,
  // unmanageable admin (the admin panel only lists local users). Enforced here
  // as well as in admin.ts createUserSchema (defense in depth).
  if (authSource === 'ldap' && request.role === 'admin') {
    throw new Error('LDAP-backed accounts cannot be admins');
  }

  const passwordHash =
    authSource === 'ldap' ? null : await hashPassword(request.password as string);

  const result = await pool.query<User>(
    `INSERT INTO users (username, password_hash, role, auth_source, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_FIELDS}`,
    [request.username, passwordHash, request.role, authSource, createdBy || null]
  );

  const user = result.rows[0];
  logger.info('User created', { userId: user.id, username: user.username, authSource });
  return sanitizeUser(user);
}

export async function updateUser(
  id: string,
  request: UpdateUserRequest
): Promise<SafeUser | null> {
  const currentResult = await pool.query<User>(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE id = $1`,
    [id]
  );

  if (currentResult.rows.length === 0) {
    return null;
  }

  const currentUser = currentResult.rows[0];

  // Keep admin strictly local: promoting an LDAP user to admin would create a
  // hidden admin (the panel lists local accounts only).
  if (request.role === 'admin' && currentUser.authSource === 'ldap') {
    throw new Error('LDAP-backed accounts cannot be promoted to admin');
  }

  const demotesLastAdmin =
    currentUser.role === 'admin' &&
    currentUser.isActive &&
    (request.role === 'user' || request.isActive === false);

  if (demotesLastAdmin) {
    const adminCount = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = true`
    );
    if (parseInt(adminCount.rows[0].count, 10) <= 1) {
      throw new Error('Cannot remove or deactivate the last admin user');
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (request.username !== undefined) {
    updates.push(`username = $${paramIndex}`);
    params.push(request.username);
    paramIndex++;
  }

  if (request.role !== undefined) {
    updates.push(`role = $${paramIndex}`);
    params.push(request.role);
    paramIndex++;
  }

  if (request.isActive !== undefined) {
    updates.push(`is_active = $${paramIndex}`);
    params.push(request.isActive);
    paramIndex++;
  }

  if (updates.length === 0) {
    return getUserById(id);
  }

  updates.push(`updated_at = NOW()`);
  params.push(id);

  const result = await pool.query<User>(
    `UPDATE users SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING ${USER_FIELDS}`,
    params
  );

  if (result.rows.length === 0) {
    return null;
  }

  logger.info('User updated', { userId: id });
  return sanitizeUser(result.rows[0]);
}

export async function deleteUser(id: string): Promise<boolean> {
  const userResult = await pool.query<User>(
    `SELECT role FROM users WHERE id = $1`,
    [id]
  );

  if (userResult.rows.length === 0) {
    return false;
  }

  if (userResult.rows[0].role === 'admin') {
    const adminCount = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = true`
    );
    if (parseInt(adminCount.rows[0].count, 10) <= 1) {
      throw new Error('Cannot delete the last admin user');
    }
  }

  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  const result = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);

  logger.info('User deleted', { userId: id });
  return (result.rowCount ?? 0) > 0;
}

export async function resetUserPassword(
  id: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const userResult = await pool.query<User>(
    `SELECT auth_source AS "authSource" FROM users WHERE id = $1`,
    [id]
  );

  if (userResult.rows.length === 0) {
    return { success: false, error: 'User not found' };
  }

  if (userResult.rows[0].authSource === 'ldap') {
    return {
      success: false,
      error:
        'This account authenticates via Active Directory — its password cannot be reset here.',
    };
  }

  const passwordHash = await hashPassword(newPassword);
  const result = await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, id]
  );

  if ((result.rowCount ?? 0) > 0) {
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    logger.info('User password reset', { userId: id });
    return { success: true };
  }
  return { success: false, error: 'User not found' };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const result = await pool.query<User>(
    `SELECT id, password_hash AS "passwordHash", auth_source AS "authSource" FROM users WHERE id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return { success: false, error: 'User not found' };
  }

  const user = result.rows[0];

  if (user.authSource === 'ldap') {
    return {
      success: false,
      error:
        'This account authenticates via Active Directory — change your password there, not in this app.',
    };
  }

  const { verifyPassword } = await import('../utils/password.js');
  const valid = user.passwordHash
    ? await verifyPassword(currentPassword, user.passwordHash)
    : false;

  if (!valid) {
    return { success: false, error: 'Current password is incorrect' };
  }

  const newHash = await hashPassword(newPassword);
  await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [newHash, userId]
  );

  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

  logger.info('Password changed', { userId });
  return { success: true };
}

export async function bulkCreateUsers(
  users: Array<{ username: string; password: string; role: 'admin' | 'user' }>,
  createdBy: string
): Promise<{ created: number; failed: number; errors: string[] }> {
  const client = await pool.connect();
  let created = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    await client.query('BEGIN');

    for (const user of users) {
      const savepoint = `user_import_${created + failed}`;
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        const passwordHash = await hashPassword(user.password);
        await client.query(
          `INSERT INTO users (username, password_hash, role, created_by)
           VALUES ($1, $2, $3, $4)`,
          [user.username, passwordHash, user.role, createdBy]
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        created++;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        failed++;
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to create ${user.username}: ${message}`);
      }
    }

    await client.query('COMMIT');
    logger.info('Bulk import completed', { created, failed });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { created, failed, errors };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [totalUsers, activeUsers, roleCounts, recentLogins, recentAudits] =
    await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(`SELECT COUNT(*) FROM users WHERE is_active = true`),
      pool.query(
        `SELECT role, COUNT(*) FROM users GROUP BY role`
      ),
      pool.query(
        `SELECT COUNT(*) FROM users WHERE last_login > NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        `SELECT COUNT(*) FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

  const roleMap: Record<string, number> = {};
  for (const row of roleCounts.rows) {
    roleMap[row.role] = parseInt(row.count, 10);
  }

  return {
    totalUsers: parseInt(totalUsers.rows[0].count, 10),
    activeUsers: parseInt(activeUsers.rows[0].count, 10),
    inactiveUsers:
      parseInt(totalUsers.rows[0].count, 10) -
      parseInt(activeUsers.rows[0].count, 10),
    adminCount: roleMap['admin'] || 0,
    userCount: roleMap['user'] || 0,
    recentLogins: parseInt(recentLogins.rows[0].count, 10),
    recentAuditLogs: parseInt(recentAudits.rows[0].count, 10),
  };
}
