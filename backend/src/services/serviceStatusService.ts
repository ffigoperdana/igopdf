import { pool } from '../config/database.js';
import {
  checkLdapAvailability,
  type LdapHealthResult,
} from './ldapService.js';

export type ServiceStatusMode = 'auto' | 'maintenance';
export type ServiceStatusState = 'operational' | 'offline' | 'maintenance';

export interface PublicServiceStatus {
  status: ServiceStatusState;
  mode: ServiceStatusMode;
  message: string | null;
  maintenanceUntil: string | null;
  adReachable: boolean;
  checkedAt: string;
  latencyMs: number;
}

export interface ServiceStatusUpdate {
  mode: ServiceStatusMode;
  message?: string | null;
  maintenanceUntil?: Date | null;
}

interface ServiceStatusRow {
  mode: ServiceStatusMode;
  message: string | null;
  maintenanceUntil: Date | null;
}

interface CachedHealth extends LdapHealthResult {
  checkedAt: Date;
}

const HEALTH_CACHE_TTL_MS = 15_000;
const DEFAULT_MAINTENANCE_MESSAGE =
  'Login Active Directory sedang maintenance. Silakan coba lagi setelah maintenance selesai.';

let cachedHealth: CachedHealth | null = null;
let healthCheckInFlight: Promise<CachedHealth> | null = null;

async function readServiceStatus(): Promise<ServiceStatusRow> {
  const result = await pool.query<ServiceStatusRow>(
    `SELECT mode, message, maintenance_until AS "maintenanceUntil"
     FROM service_status
     WHERE id = 1`
  );

  return (
    result.rows[0] ?? {
      mode: 'auto',
      message: null,
      maintenanceUntil: null,
    }
  );
}

async function clearExpiredMaintenance(): Promise<ServiceStatusRow> {
  const current = await readServiceStatus();
  if (
    current.mode !== 'maintenance' ||
    !current.maintenanceUntil ||
    current.maintenanceUntil.getTime() > Date.now()
  ) {
    return current;
  }

  await pool.query(
    `UPDATE service_status
     SET mode = 'auto', message = NULL, maintenance_until = NULL, updated_at = NOW()
     WHERE id = 1 AND mode = 'maintenance'
       AND maintenance_until IS NOT NULL
       AND maintenance_until <= NOW()`
  );

  return readServiceStatus();
}

async function refreshHealth(force = false): Promise<CachedHealth> {
  const now = Date.now();
  if (
    !force &&
    cachedHealth &&
    now - cachedHealth.checkedAt.getTime() < HEALTH_CACHE_TTL_MS
  ) {
    return cachedHealth;
  }

  if (healthCheckInFlight) return healthCheckInFlight;

  healthCheckInFlight = checkLdapAvailability()
    .then((health) => {
      cachedHealth = {
        ...health,
        checkedAt: new Date(),
      };
      return cachedHealth;
    })
    .finally(() => {
      healthCheckInFlight = null;
    });

  return healthCheckInFlight;
}

export async function getServiceStatus(
  forceHealth = false
): Promise<PublicServiceStatus> {
  const stored = await clearExpiredMaintenance();
  const health = await refreshHealth(forceHealth);
  const inMaintenance = stored.mode === 'maintenance';

  return {
    status: inMaintenance
      ? 'maintenance'
      : health.reachable
        ? 'operational'
        : 'offline',
    mode: inMaintenance ? 'maintenance' : 'auto',
    message: inMaintenance ? stored.message : null,
    maintenanceUntil: inMaintenance
      ? stored.maintenanceUntil?.toISOString() ?? null
      : null,
    adReachable: health.reachable,
    checkedAt: health.checkedAt.toISOString(),
    latencyMs: health.latencyMs,
  };
}

export async function updateServiceStatus(
  update: ServiceStatusUpdate,
  updatedBy: string
): Promise<PublicServiceStatus> {
  const maintenance = update.mode === 'maintenance';
  const message = maintenance
    ? (update.message?.trim() || DEFAULT_MAINTENANCE_MESSAGE).slice(0, 500)
    : null;
  const maintenanceUntil = maintenance ? update.maintenanceUntil ?? null : null;

  await pool.query(
    `INSERT INTO service_status
       (id, mode, message, maintenance_until, updated_by, updated_at)
     VALUES (1, $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       mode = EXCLUDED.mode,
       message = EXCLUDED.message,
       maintenance_until = EXCLUDED.maintenance_until,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [update.mode, message, maintenanceUntil, updatedBy]
  );

  return getServiceStatus(true);
}

export { DEFAULT_MAINTENANCE_MESSAGE };
