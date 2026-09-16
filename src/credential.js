// Credential file reading, grammar, and POSIX safety (§4; shared grammar from the
// dev-agents spec §4).
//
// Every tool except public `health` reads exactly one explicit absolute
// credential_file at call time. There is no other path, token argument, directory
// scan, role lookup, ambient secret, or between-call cache. The token is used as
// `Authorization: Bearer <token>` — Coolify has no password fallback, so USER and
// PASSWORD, if present under the shared format, are ignored here.
//
// No credential value is ever printed. Errors name the path and the key or format,
// never the content. The path is rendered through safePath() so a crafted path
// cannot inject a log line.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { RefusedError } from './envelope.js';
import { registerSecret, safePath } from './redact.js';

const CANONICAL_FIELDS = new Set([
  'VBCDX_AGENTS_ROLE',
  'VBCDX_AGENTS_TOKEN',
  'VBCDX_AGENTS_USER',
  'VBCDX_AGENTS_PASSWORD',
]);

/**
 * Parse the shared literal credential grammar.
 *
 * Blank lines and lines whose first non-whitespace character is `#` are ignored.
 * Assignments split at the first `=`; key and value are trimmed. Unquoted values
 * keep interior spaces, `#`, `=`, and `$` literally. Single-quoted values are
 * literal; double-quoted values use JSON string escaping. Malformed quotes,
 * trailing data after a quoted value, duplicate keys (including case-equivalent),
 * NUL bytes, and decoded line breaks in values are rejected.
 *
 * @param {string} content
 * @returns {Record<string,string>}
 * @throws {RefusedError} credential_malformed
 */
export function parseCredentialGrammar(content) {
  if (content.includes('\0')) {
    throw malformed('the file contains a NUL byte');
  }
  const lines = content.split(/\r?\n/);
  /** @type {Map<string,string>} */
  const seenLower = new Map();
  /** @type {Record<string,string>} */
  const out = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const lead = line.replace(/^\s+/, '');
    if (lead === '' || lead.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) throw malformed(`line ${lineNo} has no '=' assignment`);
    const key = line.slice(0, eq).trim();
    const rawVal = line.slice(eq + 1).trim();
    if (key === '') throw malformed(`line ${lineNo} has an empty key`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw malformed(`line ${lineNo} has a key that is not a valid identifier`);
    }

    let value;
    if (rawVal.startsWith('"')) {
      value = parseDoubleQuoted(rawVal, lineNo);
    } else if (rawVal.startsWith("'")) {
      value = parseSingleQuoted(rawVal, lineNo);
    } else {
      value = rawVal;
    }
    if (/[\r\n]/.test(value)) throw malformed(`line ${lineNo} decodes to a value with a line break`);

    const lower = key.toLowerCase();
    if (seenLower.has(lower)) {
      throw malformed(`duplicate key "${key}" (keys are compared case-insensitively)`);
    }
    seenLower.set(lower, key);
    out[key] = value;
  }
  return out;
}

function parseDoubleQuoted(rawVal, lineNo) {
  // JSON string escaping. JSON.parse rejects a malformed quote and rejects any
  // trailing data after the closing quote, which is exactly what we want.
  let value;
  try {
    value = JSON.parse(rawVal);
  } catch {
    throw malformed(`line ${lineNo} has a malformed double-quoted value`);
  }
  if (typeof value !== 'string') {
    throw malformed(`line ${lineNo} has a malformed double-quoted value`);
  }
  return value;
}

function parseSingleQuoted(rawVal, lineNo) {
  // Literal. A single-quoted value cannot contain a single quote, and nothing
  // may follow the closing quote.
  const m = /^'([^']*)'$/.exec(rawVal);
  if (!m) throw malformed(`line ${lineNo} has a malformed single-quoted value`);
  return m[1];
}

function malformed(detail) {
  return new RefusedError('credential_malformed', `Credential file is malformed: ${detail}.`);
}

/**
 * Read, safety-check, and parse a Coolify credential file, returning a validated
 * snapshot. The caller holds this snapshot for the whole call so a rotation
 * cannot switch identity mid-call.
 *
 * @param {string} path absolute credential_file path
 * @param {{ euid?: number }} [opts]
 * @returns {{ role: string, token: string }}
 * @throws {RefusedError} one of the credential_* reasons
 */
export function readCredentialFile(path, opts = {}) {
  if (typeof path !== 'string' || path === '') {
    throw new RefusedError('credential_not_absolute', 'credential_file is required and must be an absolute path.');
  }
  if (!isAbsolute(path)) {
    throw new RefusedError('credential_not_absolute',
      `credential_file must be an absolute path: ${safePath(path)}`);
  }

  const euid = opts.euid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined);
  if (euid === undefined) {
    // v1 targets POSIX. On a platform without effective-uid/mode semantics we
    // fail closed rather than claim equivalent protection.
    throw new RefusedError('credential_unsafe',
      'Credential file protection requires POSIX ownership and mode semantics, which this platform does not provide.');
  }

  assertSafe(path, euid);

  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'ENOENT') {
      throw new RefusedError('credential_missing', `Credential file not found: ${safePath(path)}`);
    }
    throw new RefusedError('credential_unreadable', `Credential file could not be read: ${safePath(path)}`);
  }

  const parsed = parseCredentialGrammar(content);

  // Reject unsupported or misspelled VBCDX_AGENTS_* fields. A case-variant prefix
  // (e.g. VBCDX_AGENTS_Token) is treated as unsupported so an alternate spelling
  // cannot slip a field past the canonical set. Unrelated non-prefixed keys are
  // ignored, and their values are never printed.
  for (const key of Object.keys(parsed)) {
    if (key.toUpperCase().startsWith('VBCDX_AGENTS_') && !CANONICAL_FIELDS.has(key)) {
      throw new RefusedError('credential_malformed',
        `Credential file has an unsupported or misspelled field "${key}".`);
    }
  }

  const role = parsed.VBCDX_AGENTS_ROLE;
  const token = parsed.VBCDX_AGENTS_TOKEN;
  if (role == null || role.trim() === '') {
    throw new RefusedError('credential_key_missing',
      `Credential file is missing VBCDX_AGENTS_ROLE: ${safePath(path)}`);
  }
  if (token == null || token.trim() === '') {
    throw new RefusedError('credential_key_missing',
      `Credential file is missing a nonblank VBCDX_AGENTS_TOKEN: ${safePath(path)}`);
  }

  registerSecret(token);
  return { role, token };
}

/**
 * Enforce POSIX safety: a regular non-symlink file owned by the effective user
 * at mode 0600, in a private immediate parent directory owned by the user at mode
 * 0700, with no symlink component in the parent chain.
 *
 * @param {string} path
 * @param {number} euid
 * @throws {RefusedError} credential_missing | credential_unsafe
 */
function assertSafe(path, euid) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'ENOENT') {
      throw new RefusedError('credential_missing', `Credential file not found: ${safePath(path)}`);
    }
    throw new RefusedError('credential_unreadable', `Credential file could not be inspected: ${safePath(path)}`);
  }
  if (st.isSymbolicLink()) {
    throw new RefusedError('credential_unsafe', `Credential file must not be a symlink: ${safePath(path)}`);
  }
  if (!st.isFile()) {
    throw new RefusedError('credential_unsafe', `Credential file must be a regular file: ${safePath(path)}`);
  }
  if (st.uid !== euid) {
    throw new RefusedError('credential_unsafe',
      `Credential file must be owned by the effective user: ${safePath(path)}`);
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw new RefusedError('credential_unsafe',
      `Credential file must have mode 0600: ${safePath(path)}`);
  }

  const parent = dirname(path);
  let pst;
  try {
    pst = lstatSync(parent);
  } catch {
    throw new RefusedError('credential_unsafe',
      `Credential file's parent directory could not be inspected: ${safePath(parent)}`);
  }
  if (pst.isSymbolicLink()) {
    throw new RefusedError('credential_unsafe',
      `Credential file's parent directory must not be a symlink: ${safePath(parent)}`);
  }
  if (!pst.isDirectory()) {
    throw new RefusedError('credential_unsafe',
      `Credential file's parent must be a directory: ${safePath(parent)}`);
  }
  if (pst.uid !== euid) {
    throw new RefusedError('credential_unsafe',
      `Credential file's parent directory must be owned by the effective user: ${safePath(parent)}`);
  }
  if ((pst.mode & 0o777) !== 0o700) {
    throw new RefusedError('credential_unsafe',
      `Credential file's parent directory must have mode 0700: ${safePath(parent)}`);
  }
  // Reject a symlink anywhere in the parent chain: if resolving the parent
  // changes it, a symlink component was traversed.
  try {
    const realParent = realpathSync(parent);
    if (realParent !== parent) {
      throw new RefusedError('credential_unsafe',
        `Credential file's path contains a symlink component: ${safePath(parent)}`);
    }
  } catch (err) {
    if (err instanceof RefusedError) throw err;
    throw new RefusedError('credential_unsafe',
      `Credential file's parent directory could not be resolved: ${safePath(parent)}`);
  }
}
