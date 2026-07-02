import { parse } from 'csv-parse/sync';
import type { BulkImportUser } from '../types/index.js';

// Default password for imported rows that have no password of their own.
// There is deliberately NO hardcoded fallback — a shared secret committed to
// source is a security hole (anyone reading the repo could log in as every
// bulk-imported user). Opt in explicitly via BULK_IMPORT_DEFAULT_PASSWORD;
// otherwise every row must carry its own password column.
export const DEFAULT_IMPORT_PASSWORD =
  process.env.BULK_IMPORT_DEFAULT_PASSWORD ?? '';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  records: BulkImportUser[];
}

function getValue(
  row: Record<string, string>,
  names: string[]
): string | undefined {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    normalized.set(key.trim().toLowerCase(), value);
  }

  for (const name of names) {
    const value = normalized.get(name.toLowerCase());
    if (value !== undefined) return value.trim();
  }

  return undefined;
}

function usernameFromEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateUsername(username: string): string | null {
  if (username.length < 3 || username.length > 150) {
    return 'username must be 3-150 characters';
  }

  if (!/^[a-zA-Z0-9._@-]+$/.test(username)) {
    return 'username can only contain letters, numbers, dots, underscores, hyphens, and @';
  }

  return null;
}

export function validateCsvContent(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const records: BulkImportUser[] = [];

  let parsed: Record<string, string>[];
  try {
    parsed = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    return {
      valid: false,
      errors: [`CSV parsing error: ${err instanceof Error ? err.message : 'Unknown error'}`],
      warnings: [],
      records: [],
    };
  }

  if (parsed.length === 0) {
    return {
      valid: false,
      errors: ['CSV file is empty or has no data rows'],
      warnings: [],
      records: [],
    };
  }

  if (parsed.length > 1000) {
    warnings.push(`Large file: ${parsed.length} rows. Processing may take time.`);
  }

  const firstRow = parsed[0];
  const columns = Object.keys(firstRow).map((col) => col.trim().toLowerCase());
  const hasUsernameColumn = columns.includes('username');
  const hasEmailColumn = columns.includes('email');
  const hasPasswordColumn = columns.includes('password');

  if (!hasUsernameColumn && !hasEmailColumn) {
    errors.push('Missing required column: username or Email');
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, records: [] };
  }

  if (!hasPasswordColumn) {
    if (!DEFAULT_IMPORT_PASSWORD) {
      errors.push(
        'No password column found and BULK_IMPORT_DEFAULT_PASSWORD is not set. ' +
          'Add a password column, or configure that environment variable.'
      );
      return { valid: false, errors, warnings, records: [] };
    }
    warnings.push(
      'No password column found. The configured BULK_IMPORT_DEFAULT_PASSWORD ' +
        'will be used for rows without a password.'
    );
  }

  const seenUsernames = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const rowNum = i + 2;
    const rawUsername = getValue(row, ['username']);
    const email = getValue(row, ['email', 'Email']);
    const username = rawUsername || (email ? usernameFromEmail(email) : '');
    const password = getValue(row, ['password', 'Password']) || DEFAULT_IMPORT_PASSWORD;
    const role = (getValue(row, ['role', 'Role']) || 'user').toLowerCase();

    if (!username) {
      errors.push(`Row ${rowNum}: username is required`);
      continue;
    }

    const usernameError = validateUsername(username);
    if (usernameError) {
      errors.push(`Row ${rowNum}: ${usernameError}`);
      continue;
    }

    if (seenUsernames.has(username.toLowerCase())) {
      errors.push(`Row ${rowNum}: duplicate username "${username}"`);
      continue;
    }
    seenUsernames.add(username.toLowerCase());

    if (password.length < 8) {
      errors.push(`Row ${rowNum}: password must be at least 8 characters`);
      continue;
    }

    if (role !== 'admin' && role !== 'user') {
      errors.push(`Row ${rowNum}: role must be "admin" or "user"`);
      continue;
    }

    records.push({
      username,
      password,
      role: role as 'admin' | 'user',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    records,
  };
}

export function validateTxtContent(content: string): ValidationResult {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const csvContent =
    'username,password,role\n' +
    lines
      .map((line) => {
        const [username, password = DEFAULT_IMPORT_PASSWORD, role = 'user'] =
          line.split(',').map((value) => value.trim());
        return `${username},${password},${role}`;
      })
      .join('\n');
  return validateCsvContent(csvContent);
}
