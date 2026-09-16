import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockCoolify, tmpCredential, call, envelopeOf } from './helpers.js';

let mock;
let cred;
afterEach(async () => {
  if (mock) await mock.close();
  if (cred) cred.cleanup();
  mock = cred = null;
});

test('health: no credential required, returns ok', async () => {
  mock = await mockCoolify({ 'GET /api/v1/health': { status: 200, text: 'OK' } });
  const env = envelopeOf(await call('health', {}, { url: mock.url }));
  assert.equal(env.outcome, 'ok');
  assert.deepEqual(env.data, { ok: true, body: 'OK' });
  // health request carried no Authorization header.
  assert.ok(!mock.requests[0].headers.authorization);
});

test('health: unexpected body -> failed', async () => {
  mock = await mockCoolify({ 'GET /api/v1/health': { status: 200, text: 'MAINTENANCE' } });
  const env = envelopeOf(await call('health', {}, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'unexpected_response');
});

test('version: text response trimmed', async () => {
  mock = await mockCoolify({ 'GET /api/v1/version': { status: 200, text: 'v4.0.0-beta.1\n' } });
  cred = tmpCredential();
  const env = envelopeOf(await call('version', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'ok');
  assert.deepEqual(env.data, { version: 'v4.0.0-beta.1' });
  assert.equal(mock.requests[0].headers.authorization, 'Bearer TEST-TOKEN-abc123');
});

test('list_applications: window + projection', async () => {
  const apps = Array.from({ length: 5 }, (_, i) => ({ uuid: `u${i}`, name: `n${i}`, git_commit_sha: 'x', secret_field: 'nope' }));
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, json: apps } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path, offset: 1, limit: 2 }, { url: mock.url }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.data.total, 5);
  assert.equal(env.data.count, 2);
  assert.equal(env.data.offset, 1);
  assert.equal(env.data.next_offset, 3);
  assert.equal(env.data.truncated, true);
  // Projection does not leak unlisted fields.
  assert.ok(!('secret_field' in env.data.items[0]));
});

test('list_applications: non-array body -> failed, not empty list', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, json: { oops: true } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'unexpected_response');
});

test('list_applications: tag filter is sent as a query param', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, json: [] } });
  cred = tmpCredential();
  await call('list_applications', { credential_file: cred.path, tag: 'prod' }, { url: mock.url });
  assert.match(mock.requests[0].query, /tag=prod/);
});

test('get_application: detail projection', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications/abc': { status: 200, json: { uuid: 'abc', name: 'n', health_check_path: '/h', private_key: 'LEAK' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('get_application', { credential_file: cred.path, uuid: 'abc' }, { url: mock.url }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.data.health_check_path, '/h');
  assert.ok(!('private_key' in env.data));
});

test('list_application_envs: values hidden unless include_values', async () => {
  const envs = [{ uuid: 'e1', key: 'A', value: 'secret', is_preview: false }];
  mock = await mockCoolify({ 'GET /api/v1/applications/abc/envs': { status: 200, json: envs } });
  cred = tmpCredential();
  let env = envelopeOf(await call('list_application_envs', { credential_file: cred.path, uuid: 'abc' }, { url: mock.url }));
  assert.equal(env.data.items[0].value_state, 'not_requested');
  assert.ok(!('value' in env.data.items[0]));

  await mock.close();
  mock = await mockCoolify({ 'GET /api/v1/applications/abc/envs': { status: 200, json: envs } });
  env = envelopeOf(await call('list_application_envs', { credential_file: cred.path, uuid: 'abc', include_values: true }, { url: mock.url }));
  assert.equal(env.data.items[0].value_state, 'available');
  assert.equal(env.data.items[0].value, 'secret');
});

test('get_application_logs: requires include_sensitive true', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications/abc/logs': { status: 200, json: { logs: 'line1\nline2' } } });
  cred = tmpCredential();
  const refused = envelopeOf(await call('get_application_logs', { credential_file: cred.path, uuid: 'abc' }, { url: mock.url }));
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reason, 'validation_failed');

  const ok = envelopeOf(await call('get_application_logs', { credential_file: cred.path, uuid: 'abc', include_sensitive: true }, { url: mock.url }));
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.data.value_state, 'available');
  assert.equal(ok.data.logs, 'line1\nline2');
});

test('list_resources: combines three typed lists, sorted by type then uuid', async () => {
  mock = await mockCoolify({
    'GET /api/v1/applications': { status: 200, json: [{ uuid: 'a2' }, { uuid: 'a1' }] },
    'GET /api/v1/databases': { status: 200, json: [{ uuid: 'd1' }] },
    'GET /api/v1/services': { status: 200, json: [{ uuid: 's1' }] },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_resources', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.data.total, 4);
  assert.deepEqual(env.data.items.map((x) => `${x.type}:${x.uuid}`), ['application:a1', 'application:a2', 'database:d1', 'service:s1']);
});

test('list_resources: a failed component fails the whole call with evidence', async () => {
  mock = await mockCoolify({
    'GET /api/v1/applications': { status: 200, json: [{ uuid: 'a1' }] },
    'GET /api/v1/databases': { status: 500, json: { message: 'boom' } },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('list_resources', { credential_file: cred.path }, { url: mock.url }));
  assert.equal(env.outcome, 'failed');
  assert.ok(env.evidence.failed_component.includes('/databases'));
});

test('missing credential_file -> refused validation_failed before any request', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 200, json: [] } });
  const env = envelopeOf(await call('list_applications', {}, { url: mock.url }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'validation_failed');
  assert.equal(env.request.attempted, false);
  assert.equal(mock.requests.length, 0);
});

test('server not configured -> refused, tool still callable', async () => {
  cred = tmpCredential();
  const env = envelopeOf(await call('list_applications', { credential_file: cred.path }, { url: '' }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'server_not_configured');
});
