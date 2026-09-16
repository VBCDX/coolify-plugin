// Direct unit tests for the scrub() backstop. The end-to-end secret-safety
// tests pass on the primary defence alone (the raw upstream body never reaches
// the envelope), so they never exercise this registered-secret path. These do:
// register a secret, run text through scrub(), and assert the value is gone.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, clearSecrets, scrub } from '../src/redact.js';

afterEach(() => clearSecrets());

test('a registered secret is scrubbed from a single-line string', () => {
  const secret = 'sk-FAKE-SENTINEL-NEVER-REAL-0001';
  registerSecret(secret);
  const out = scrub(`token is ${secret} done`);
  assert.ok(!out.includes(secret), 'secret must not survive scrub()');
  assert.equal(out, 'token is <redacted> done');
});

test('a secret that is a substring of surrounding text is still scrubbed', () => {
  const secret = 'abc123';
  registerSecret(secret);
  const out = scrub(`xxabc123yy and abc123 again`);
  assert.ok(!out.includes(secret));
  assert.equal(out, 'xx<redacted>yy and <redacted> again');
});

test('a secret containing regex metacharacters is scrubbed literally', () => {
  // The one most likely to break a naive fix: split/join treats the needle as a
  // literal string, so metacharacters must match themselves, not act as a regex.
  const secret = 'a.b*c+d(e)[f]{g}|h^i$j\\k?';
  registerSecret(secret);
  const out = scrub(`before ${secret} after`);
  assert.ok(!out.includes(secret));
  assert.equal(out, 'before <redacted> after');
  // And a string that merely matches the secret *as a regex* is left untouched.
  assert.equal(scrub('axbcd'), 'axbcd');
});

test('a multi-line secret value is scrubbed across newlines', () => {
  const secret = 'line-one-KEY\nline-two-KEY\nline-three-KEY';
  registerSecret(secret);
  const out = scrub(`header\n${secret}\nfooter`);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('line-two-KEY'));
  assert.equal(out, 'header\n<redacted>\nfooter');
});

test('a secret in an error message is scrubbed, not just a log line', () => {
  const secret = 'sk-FAKE-SENTINEL-NEVER-REAL-0002';
  registerSecret(secret);
  const err = new Error(`connect failed using ${secret}`);
  const out = scrub(err.message);
  assert.ok(!out.includes(secret));
  assert.equal(out, 'connect failed using <redacted>');
});

test('an empty value is never registered and does not redact everything', () => {
  // registerSecret ignores empty strings; scrub must not treat "" as a match and
  // shatter the whole string into <redacted> markers.
  registerSecret('');
  const out = scrub('nothing secret here');
  assert.equal(out, 'nothing secret here');
});

test('scrub coerces a non-string input without throwing', () => {
  const secret = 'sk-FAKE-SENTINEL-NEVER-REAL-0003';
  registerSecret(secret);
  assert.equal(scrub(undefined), '');
  assert.equal(scrub(null), '');
  assert.equal(scrub(42), '42');
  // A non-string carrying the secret in its string form is still scrubbed.
  assert.equal(scrub({ toString: () => `obj ${secret}` }), 'obj <redacted>');
});

test('scrubbing works with multiple registered secrets at once', () => {
  registerSecret('AAAA-token');
  registerSecret('BBBB-token');
  const out = scrub('first AAAA-token then BBBB-token');
  assert.equal(out, 'first <redacted> then <redacted>');
});

// Finding 1 (Refs #12): when one registered secret is a proper substring of
// another, redaction must be independent of registration order. The bug was that
// iterating shorter-first split the longer secret and left its tail behind. The
// short sentinel below is a proper prefix of the long one.
const SHORT_SENTINEL = 'sk-FAKE-SENTINEL-NEVER-REAL-0004';
const LONG_SENTINEL = 'sk-FAKE-SENTINEL-NEVER-REAL-0004-EXTRA-TAIL';

test('overlapping secrets registered shorter-first do not leak the longer tail', () => {
  registerSecret(SHORT_SENTINEL);
  registerSecret(LONG_SENTINEL);
  const out = scrub(LONG_SENTINEL);
  assert.ok(!out.includes('EXTRA-TAIL'), 'longer secret tail must not survive');
  assert.ok(!out.includes(LONG_SENTINEL));
  assert.equal(out, '<redacted>');
});

test('overlapping secrets registered longer-first also fully redact', () => {
  registerSecret(LONG_SENTINEL);
  registerSecret(SHORT_SENTINEL);
  const out = scrub(LONG_SENTINEL);
  assert.ok(!out.includes('EXTRA-TAIL'));
  assert.equal(out, '<redacted>');
});

// Finding 2 (Refs #12): a null-prototype object cannot be String()-coerced and
// used to throw a TypeError, which stops the backstop from scrubbing at all.
test('scrub does not throw on a null-prototype object', () => {
  const secret = 'sk-FAKE-SENTINEL-NEVER-REAL-0005';
  registerSecret(secret);
  const weird = Object.create(null);
  let out;
  assert.doesNotThrow(() => {
    out = scrub(weird);
  }, 'the backstop must never throw, whatever it is handed');
  assert.ok(!out.includes(secret), 'no secret survives an un-coercible value');
});
