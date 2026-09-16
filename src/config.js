// Server configuration and request limits (§3).
//
// Settings are read from the process environment into a plain object that is
// isolated per instance — there is no module-global mutable config that a second
// server in the same process could stamp on. Only three nonsecret settings are
// read: VBCDX_COOLIFY_URL, VBCDX_COOLIFY_WRITES, VBCDX_COOLIFY_TIMEOUT_MS. There
// is deliberately no COOLIFY_ROOT_TOKEN*, no env-file search, no home-directory
// scan, no startup role, and no ambient secret fallback.

import { safePath } from './redact.js';

export const DEFAULT_TIMEOUT_MS = 30000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120000;

const WRITE_LEVELS = ['off', 'write', 'full'];

/**
 * Normalize a Coolify instance URL into its API base (§3).
 *
 * Accepts an HTTP(S) URL with an optional deployment path prefix and an optional
 * trailing `/api/v1`; returns origin + prefix + `/api/v1` with the suffix
 * appended exactly once. Rejects userinfo, query, fragment, control characters,
 * and unsafe path components.
 *
 * @param {string} raw
 * @returns {{apiBase: string, insecure: boolean}}
 * @throws {Error} with a secret-free message (the URL is nonsecret config)
 */
export function normalizeCoolifyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('VBCDX_COOLIFY_URL is not set.');
  }
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('VBCDX_COOLIFY_URL contains control characters.');
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`VBCDX_COOLIFY_URL is not a valid URL: ${safePath(value)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`VBCDX_COOLIFY_URL must be http(s), got protocol "${u.protocol}".`);
  }
  if (u.username || u.password) {
    throw new Error('VBCDX_COOLIFY_URL must not contain embedded credentials (userinfo).');
  }
  if (u.search) {
    throw new Error('VBCDX_COOLIFY_URL must not contain a query string.');
  }
  if (u.hash) {
    throw new Error('VBCDX_COOLIFY_URL must not contain a fragment.');
  }
  // Split the deployment prefix off the path, dropping any trailing /api/v1 so we
  // can append it exactly once.
  let segments = u.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length >= 2 && segments[segments.length - 2] === 'api' && segments[segments.length - 1] === 'v1') {
    segments = segments.slice(0, -2);
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error('VBCDX_COOLIFY_URL path contains unsafe components.');
    }
  }
  const prefix = segments.length ? '/' + segments.join('/') : '';
  const apiBase = `${u.protocol}//${u.host}${prefix}/api/v1`;
  return { apiBase, insecure: u.protocol === 'http:' };
}

/**
 * Load an isolated config snapshot from an environment accessor.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{
 *   writes: 'off'|'write'|'full',
 *   writesInvalid: boolean,
 *   timeoutMs: number,
 *   apiBase: string|null,
 *   urlConfigured: boolean,
 *   insecure: boolean,
 *   configError: {reason: string, message: string}|null
 * }}
 */
export function loadConfig(env = process.env) {
  // Write level. An invalid value behaves as off (§3), and is not a hard error.
  const rawWrites = (env.VBCDX_COOLIFY_WRITES ?? 'off').trim();
  const writesInvalid = !WRITE_LEVELS.includes(rawWrites);
  const writes = writesInvalid ? 'off' : /** @type {'off'|'write'|'full'} */ (rawWrites);

  // Timeout. Out-of-range or non-integer is a visible config error (tools stay
  // listed; the error surfaces at call time), not a silent clamp.
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  /** @type {{reason:string,message:string}|null} */
  let configError = null;
  const rawTimeout = env.VBCDX_COOLIFY_TIMEOUT_MS;
  if (rawTimeout != null && String(rawTimeout).trim() !== '') {
    const n = Number(String(rawTimeout).trim());
    if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
      configError = {
        reason: 'server_not_configured',
        message: `VBCDX_COOLIFY_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
      };
    } else {
      timeoutMs = n;
    }
  }

  // URL. Missing or invalid is not fatal to discovery; it becomes a per-call
  // server_not_configured error.
  let apiBase = null;
  let insecure = false;
  let urlConfigured = false;
  const rawUrl = env.VBCDX_COOLIFY_URL;
  if (rawUrl != null && String(rawUrl).trim() !== '') {
    urlConfigured = true;
    try {
      const normalized = normalizeCoolifyUrl(rawUrl);
      apiBase = normalized.apiBase;
      insecure = normalized.insecure;
    } catch (err) {
      if (!configError) {
        configError = { reason: 'server_not_configured', message: err.message };
      }
    }
  }

  return { writes, writesInvalid, timeoutMs, apiBase, urlConfigured, insecure, configError };
}
