// Redaction helpers.
//
// The one rule this whole package answers to: a credential value must never
// appear in a log line, an error message, a tool result, a commit, or a
// published file. A sibling MCP plugin once shipped a leak where a single-line
// credential payload was classed as a path and printed verbatim. We never
// classify by shape, and we never pass
// a raw OS or upstream buffer through to output; everything user-visible is
// built from fixed strings and values we have deliberately allowed.

/**
 * Active-call secrets to scrub from any diagnostic string. Reference-counted so
 * concurrent calls with different (or identical) credential files each register
 * and release their own token without one call clearing another's — the registry
 * is process-wide but the lifetime is per-call.
 * @type {Map<string, number>}
 */
const activeSecrets = new Map();

/** Register a secret value to be scrubbed from diagnostics during a call. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length > 0) {
    activeSecrets.set(value, (activeSecrets.get(value) || 0) + 1);
  }
}

/** Release one registration of a secret. Call in a finally after each call. */
export function unregisterSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return;
  const n = activeSecrets.get(value);
  if (n === undefined) return;
  if (n <= 1) activeSecrets.delete(value);
  else activeSecrets.set(value, n - 1);
}

/** Clear all registered secrets (defensive; used by tests). */
export function clearSecrets() {
  activeSecrets.clear();
}

/**
 * Scrub any registered secret substring, plus anything that looks like a bearer
 * header, from a string. Belt and suspenders: we already avoid putting secrets
 * into strings, but a defensive scrub means an accidental interpolation degrades
 * to `<redacted>` rather than leaking.
 *
 * Known limitations, deliberately not "fixed" (see PR discussion, Refs #12):
 *   - Unicode normalization: a secret registered in one form (e.g. NFC) will not
 *     match the same glyphs supplied in another (NFD). Nothing in the pipeline
 *     re-normalizes a credential between registration and output, so the mismatch
 *     is not reachable in practice; normalizing both sides would rewrite the bytes
 *     of legitimate non-ASCII diagnostic text, which is a worse trade.
 *   - Minimum secret length: a very short registered secret over-redacts
 *     surrounding text. That fails safe (never a leak); a length guard would risk
 *     skipping a genuinely short credential, which would be a real leak. Not worth
 *     it, so there is no guard.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function scrub(text) {
  let out;
  if (typeof text === 'string') {
    out = text;
  } else {
    // `String(text ?? '')` throws on a value that cannot be coerced to a
    // primitive — e.g. a null-prototype object, which has no reachable
    // toString/valueOf. A backstop that throws stops scrubbing, so fall back to
    // a form that never throws and cannot carry a secret verbatim.
    try {
      out = String(text ?? '');
    } catch {
      out = Object.prototype.toString.call(text);
    }
  }
  // Secrets are the Map keys; iterate keys(), not the Map itself (which yields
  // [key, count] entry pairs and would never match the secret string). Iterate
  // longest-first so that when one registered secret is a substring of another,
  // the most specific match is consumed before a shorter one can split it and
  // leave the longer secret's tail behind. This makes the result independent of
  // registration order.
  const secretsByLength = [...activeSecrets.keys()].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of secretsByLength) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  // A defensive catch for an Authorization header that reached a string despite
  // us never intentionally formatting one.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  return out;
}

/**
 * Render a filesystem path safely for an error message. Paths are not secret,
 * but control characters in a crafted path could corrupt a terminal or a log,
 * so they are escaped. The path itself is preserved so the operator can act on
 * the error.
 *
 * @param {string} p
 * @returns {string}
 */
export function safePath(p) {
  const s = String(p ?? '');
  // Escape ASCII control characters (including newline/tab) as \xNN so a crafted
  // path cannot inject log lines or terminal escapes.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, (c) =>
    '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
  );
}
