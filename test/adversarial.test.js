import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockCoolify, tmpCredential, call, envelopeOf } from './helpers.js';

let mock;
let cred;
afterEach(async () => {
  if (mock) await mock.close();
  if (cred) cred.cleanup();
  mock = cred = null;
});

test('401 -> failed credential_rejected, no other-token fallback', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 401, json: { message: 'Unauthenticated.' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'credential_rejected');
  assert.equal(mock.requests.length, 1); // no retry
});

test('403 -> failed permission_denied, no broader credential', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 403, json: { message: 'forbidden' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'permission_denied');
  assert.equal(mock.requests.length, 1);
});

test('403 with a success:true body is still a failure (status checked first)', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 403, json: { success: true, data: [] } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'permission_denied');
});

test('redirect is refused, never followed off-origin', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 302, headers: { location: 'https://evil.example.com/' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'unexpected_response');
});

test('malformed JSON -> failed unexpected_response, not empty list', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, headers: { 'content-type': 'application/json' }, raw: '{ this is not json' } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'unexpected_response');
});

test('oversized body (declared) -> failed response_too_large', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) }, raw: '[]' } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'response_too_large');
});

test('oversized body (streamed, no content-length) -> failed response_too_large', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, headers: { 'content-type': 'application/json' }, raw: big } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'response_too_large');
});

test('429 -> failed rate_limited, Retry-After preserved', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 429, headers: { 'retry-after': '30' }, json: { message: 'slow down' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'rate_limited');
  assert.equal(env.evidence.retry_after, '30');
});

test('timeout on a read -> failed timeout (no retry)', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, json: [], delayMs: 1500 } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url, timeoutMs: 1000 }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'timeout');
  assert.equal(mock.requests.length, 1);
});

test('timeout on a mutation -> indeterminate (may have applied, no replay)', async () => {
  mock = await mockCoolify({ 'POST /api/v1/deploy': { status: 200, json: { deployments: [] }, delayMs: 1500 } });
  cred = tmpCredential();
  const env = envelopeOf(await call('deploy', { uuid: 'r1', credential_file: cred.path }, { url: mock.url, writes: 'write', timeoutMs: 1000 }));
  assert.equal(env.outcome, 'indeterminate');
  assert.equal(env.reason, 'timeout');
  assert.equal(mock.requests.length, 1);
});

test('204/empty text on a read is handled (not a crash)', async () => {
  mock = await mockCoolify({ 'GET /api/v1/version': { status: 204 } });
  cred = tmpCredential();
  const env = envelopeOf(await call('version', { credential_file: cred.path }, { url: mock.url }));
  // Empty version is explicitly unexpected, not a silent empty success.
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'unexpected_response');
});
