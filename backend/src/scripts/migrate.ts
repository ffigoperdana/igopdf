import { pool } from '../config/database.js';
import { logger } from '../utils/logger.js';

const migrations = [
  {
    name: '001_initial_schema',
    sql: `
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_login TIMESTAMP WITH TIME ZONE,
        created_by UUID REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        ip_address INET,
        user_agent TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS login_attempts (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(150) NOT NULL,
        ip_address INET NOT NULL,
        success BOOLEAN NOT NULL,
        attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        details JSONB,
        ip_address INET,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

      CREATE TABLE IF NOT EXISTS captcha_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        answer_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha_tokens(expires_at);

      ALTER TABLE users ALTER COLUMN username TYPE VARCHAR(150);
      ALTER TABLE login_attempts ALTER COLUMN username TYPE VARCHAR(150);
    `,
  },
  {
    name: '002_expand_username_for_email_import',
    sql: `
      ALTER TABLE users ALTER COLUMN username TYPE VARCHAR(150);
      ALTER TABLE login_attempts ALTER COLUMN username TYPE VARCHAR(150);
    `,
  },
  {
    name: '003_add_ldap_auth_source',
    sql: `
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'ldap'));
      ALTER TABLE users ADD CONSTRAINT chk_local_users_have_password
        CHECK (auth_source != 'local' OR password_hash IS NOT NULL);
    `,
  },
  {
    name: '004_case_insensitive_username_unique',
    // login() resolves users case-insensitively (LOWER(username)), but the base
    // UNIQUE(username) is case-SENSITIVE — so a local 'Admin' and an
    // LDAP-provisioned 'admin' could coexist and be conflated, making the
    // "prefer local" invariant query-time-only. A functional unique index
    // enforces it at the schema level. IF NOT EXISTS keeps it idempotent; it
    // will fail if case-duplicate usernames already exist — dedupe those first.
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
        ON users (LOWER(username));
    `,
  },
  {
    name: '005_usage_events',
    // Lightweight usage analytics for the admin Reports dashboard: one row per
    // tool-page visit (beaconed from the frontend). username is denormalized
    // so reports survive user deletion; user_id nulls out via ON DELETE.
    sql: `
      CREATE TABLE IF NOT EXISTS usage_events (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        username VARCHAR(150) NOT NULL,
        feature VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_feature ON usage_events(feature);
      CREATE INDEX IF NOT EXISTS idx_usage_events_username ON usage_events(username);
    `,
  },
];

async function runMigrations(rollback: boolean = false) {
  const client = await pool.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    if (rollback) {
      const result = await client.query(
        'SELECT name FROM _migrations ORDER BY id DESC LIMIT 1'
      );
      
      if (result.rows.length === 0) {
        logger.info('No migrations to rollback');
        return;
      }

      const lastMigration = result.rows[0].name;
      logger.info(`Rolling back migration: ${lastMigration}`);
      
      await client.query('DELETE FROM _migrations WHERE name = $1', [lastMigration]);
      logger.info(`Rolled back: ${lastMigration}`);
      return;
    }

    for (const migration of migrations) {
      const result = await client.query(
        'SELECT name FROM _migrations WHERE name = $1',
        [migration.name]
      );

      if (result.rows.length > 0) {
        logger.info(`Skipping already applied migration: ${migration.name}`);
        continue;
      }

      logger.info(`Applying migration: ${migration.name}`);
      
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [migration.name]
        );
        await client.query('COMMIT');
        logger.info(`Applied: ${migration.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info('All migrations applied successfully');
  } finally {
    client.release();
  }
}

const isRollback = process.argv.includes('rollback');
runMigrations(isRollback)
  .then(() => {
    logger.info('Migration complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Migration failed', err);
    process.exit(1);
  });
