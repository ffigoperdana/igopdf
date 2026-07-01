import pg from 'pg';
import { config } from './index.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[Database] Unexpected error on idle client', err);
  process.exit(-1);
});

export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    console.log('[Database] Connected successfully');
    client.release();
    return true;
  } catch (err) {
    console.error('[Database] Connection failed:', err);
    return false;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  console.log('[Database] Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
  return result;
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

export async function closePool(): Promise<void> {
  await pool.end();
  console.log('[Database] Pool closed');
}
