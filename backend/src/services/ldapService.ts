import ldap from 'ldapjs';
import fs from 'fs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface LdapAuthResult {
  success: boolean;
  error?: string;
  // 'unreachable' = the DC couldn't be contacted at all (timeout/refused/
  // reset) — a network/topology condition, not a credential failure. Lets the
  // login flow show a "connect to the office network" hint instead of
  // "wrong password", and skip the account-lockout counter.
  code?: 'unreachable';
}

/**
 * Escapes special characters in a value used inside an LDAP search filter,
 * per RFC 4515. Defense in depth — usernames should already be constrained
 * upstream, but this makes the filter safe even if that ever changes.
 */
function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\5c';
      case '*':
        return '\\2a';
      case '(':
        return '\\28';
      case ')':
        return '\\29';
      case '\0':
        return '\\00';
      default:
        return char;
    }
  });
}

const VALID_TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];

function createClient(): ldap.Client {
  const options: ldap.ClientOptions = {
    url: config.ldap.url,
    timeout: config.ldap.timeoutMs,
    connectTimeout: config.ldap.timeoutMs,
    // A login is a one-shot bind; don't spin in ldapjs' reconnect/backoff loop
    // when the DC is unreachable — fail fast so login() returns an error.
    reconnect: false,
  };

  // TLS options only matter for ldaps:// URLs; for plain ldap:// they're ignored.
  // rejectUnauthorized defaults to true (verify the DC certificate). For an
  // internal self-signed AD cert either set LDAP_TLS_REJECT_UNAUTHORIZED=false
  // (encrypts but doesn't verify server identity) or point LDAP_TLS_CA_FILE at
  // the internal CA cert to verify it properly.
  if (config.ldap.url.toLowerCase().startsWith('ldaps://')) {
    const tlsOptions: {
      rejectUnauthorized: boolean;
      ca?: Buffer[];
      minVersion?: string;
    } = {
      rejectUnauthorized: config.ldap.tlsRejectUnauthorized,
    };
    if (config.ldap.tlsCaFile) {
      try {
        tlsOptions.ca = [fs.readFileSync(config.ldap.tlsCaFile)];
      } catch (err) {
        logger.error(
          'Could not read LDAP_TLS_CA_FILE; falling back to system CAs',
          {
            path: config.ldap.tlsCaFile,
            message: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }
    // Some AD domain controllers only offer TLS 1.0/1.1 on LDAPS, which Node's
    // default floor (TLS 1.2) rejects with an ECONNRESET mid-handshake. Allow
    // lowering the floor via LDAP_TLS_MIN_VERSION. This weakens transport
    // security, so only use it when the DC genuinely can't negotiate TLS 1.2.
    if (config.ldap.tlsMinVersion) {
      if (VALID_TLS_VERSIONS.includes(config.ldap.tlsMinVersion)) {
        tlsOptions.minVersion = config.ldap.tlsMinVersion;
      } else {
        logger.warn('Ignoring invalid LDAP_TLS_MIN_VERSION', {
          value: config.ldap.tlsMinVersion,
          allowed: VALID_TLS_VERSIONS,
        });
      }
    }
    options.tlsOptions = tlsOptions;
  }

  const client = ldap.createClient(options);

  // A connection- or TLS-level failure (DC unreachable, TLS handshake reset,
  // socket dropped) surfaces as an 'error' event on the client. With no
  // listener attached, Node re-throws it as an uncaught exception and crashes
  // the entire backend process. Log it instead so the process survives; the
  // bind/search wrappers turn the failure into a graceful login error.
  client.on('error', (err: Error) => {
    logger.warn('LDAP client connection error', {
      url: config.ldap.url,
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return client;
}

function bindClient(
  client: ldap.Client,
  dn: string,
  password: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // If the socket dies before/during the bind (e.g. TLS handshake reset),
    // ldapjs emits 'error'/'connectError' rather than invoking the bind
    // callback. Reject promptly on either so authenticateLdap can return a
    // clean failure instead of hanging until the operation timeout.
    const onConnErr = (err: Error) => {
      if (settled) return;
      settled = true;
      client.removeListener('error', onConnErr);
      client.removeListener('connectError', onConnErr);
      reject(err);
    };
    client.once('error', onConnErr);
    client.once('connectError', onConnErr);
    client.bind(dn, password, (err) => {
      if (settled) return;
      settled = true;
      client.removeListener('error', onConnErr);
      client.removeListener('connectError', onConnErr);
      if (err) reject(err);
      else resolve();
    });
  });
}

function unbindQuietly(client: ldap.Client): void {
  try {
    client.unbind();
  } catch {
    // already unbound / connection already closed — nothing to do
  }
}

function findUserDn(
  client: ldap.Client,
  username: string
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const opts = {
      filter: `(${config.ldap.loginField}=${escapeLdapFilter(username)})`,
      scope: 'sub' as const,
      attributes: ['dn'],
    };

    client.search(config.ldap.baseDn, opts, (err, res) => {
      if (err) {
        reject(err);
        return;
      }

      let foundDn: string | null = null;

      res.on('searchEntry', (entry) => {
        foundDn =
          (entry as unknown as { objectName?: { toString(): string } })
            .objectName?.toString() ?? entry.dn?.toString() ?? null;
      });
      res.on('error', (searchErr) => reject(searchErr));
      res.on('end', () => resolve(foundDn));
    });
  });
}

/**
 * Verifies a username/password against Active Directory using the
 * search-then-bind pattern:
 *   1. Bind as the configured service account (LDAP_BIND_DN) to search
 *      the directory for the DN matching the submitted username.
 *   2. Attempt to bind AS that user's DN using the password they typed.
 * Step 2 is what actually validates the password — we never read or
 * compare it ourselves, so a wrong password just fails the bind.
 */
export async function authenticateLdap(
  username: string,
  password: string
): Promise<LdapAuthResult> {
  if (!config.ldap.enabled) {
    return { success: false, error: 'LDAP authentication is not enabled' };
  }
  if (!password) {
    return { success: false, error: 'Password required' };
  }
  if (
    !config.ldap.url ||
    !config.ldap.baseDn ||
    !config.ldap.bindDn ||
    !config.ldap.bindPassword
  ) {
    // An empty bindPassword is especially dangerous: binding a valid bindDn
    // with an empty password is an RFC 4513 unauthenticated bind that AD
    // accepts as anonymous, so the search would silently run without the
    // intended service-account privileges. Treat it as misconfiguration.
    logger.error('LDAP is enabled but not fully configured', {
      hasUrl: Boolean(config.ldap.url),
      hasBaseDn: Boolean(config.ldap.baseDn),
      hasBindDn: Boolean(config.ldap.bindDn),
      hasBindPassword: Boolean(config.ldap.bindPassword),
    });
    return { success: false, error: 'Directory server misconfigured' };
  }

  const searchClient = createClient();

  try {
    await bindClient(searchClient, config.ldap.bindDn, config.ldap.bindPassword);

    const userDn = await findUserDn(searchClient, username);
    if (!userDn) {
      return { success: false, error: 'User not found in directory' };
    }

    unbindQuietly(searchClient);

    const userClient = createClient();
    try {
      await bindClient(userClient, userDn, password);
      return { success: true };
    } catch (bindErr) {
      logger.warn('LDAP user bind failed', {
        username,
        message: bindErr instanceof Error ? bindErr.message : String(bindErr),
      });
      return { success: false, error: 'Invalid username or password' };
    } finally {
      unbindQuietly(userClient);
    }
  } catch (err) {
    logger.error('LDAP authentication error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: 'Directory server unavailable',
      code: 'unreachable',
    };
  } finally {
    unbindQuietly(searchClient);
  }
}
