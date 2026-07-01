import { pool } from '../config/database.js';
import { hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

async function seed() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const isProduction = process.env.NODE_ENV === 'production';
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (isProduction && (!adminPassword || adminPassword.length < 12)) {
      throw new Error(
        'ADMIN_PASSWORD must be set to at least 12 characters when seeding production'
      );
    }

    const resolvedAdminPassword = adminPassword || 'Admin123!';
    const adminPasswordHash = await hashPassword(resolvedAdminPassword);

    const existingAdmin = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [adminUsername]
    );

    if (existingAdmin.rows.length === 0) {
      await client.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)`,
        [adminUsername, adminPasswordHash, 'admin']
      );
      logger.info('Created admin user', { username: adminUsername });
    } else {
      logger.info('Admin user already exists, skipping');
    }

    if (!isProduction) {
      const userPasswordHash = await hashPassword('User123!');
      const existingUser = await client.query(
        'SELECT id FROM users WHERE username = $1',
        ['user']
      );

      if (existingUser.rows.length === 0) {
        await client.query(
          `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)`,
          ['user', userPasswordHash, 'user']
        );
        logger.info('Created regular user (user / User123!)');
      } else {
        logger.info('Regular user already exists, skipping');
      }
    }

    await client.query('COMMIT');
    logger.info('Seed completed successfully');
    if (!isProduction) {
      logger.info('Development accounts:');
      logger.info('  Admin: admin / Admin123!');
      logger.info('  User:  user / User123!');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Seed failed', err);
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Seed error', err);
    process.exit(1);
  });
