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

test('destructive requires writes=full', async () => {
  mock = await mockCoolify({});
  cred = tmpCredential();
  for (const writes of ['off', 'write']) {
    const env = envelopeOf(await call('restart_application', { uuid: 'abc', confirm: 'restart application abc', credential_file: cred.path }, { url: mock.url, writes }));
    assert.equal(env.outcome, 'refused');
    assert.equal(env.reason, 'write_gate_disabled');
  }
  assert.equal(mock.requests.length, 0);
});

test('restart_application: confirmation mismatch refused before any request', async () => {
  mock = await mockCoolify({ 'POST /api/v1/applications/abc/restart': { status: 200, json: { message: 'queued' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('restart_application', { uuid: 'abc', confirm: 'restart application WRONG', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'confirmation_mismatch');
  assert.equal(mock.requests.length, 0);
});

test('restart_application: correct confirmation -> accepted', async () => {
  mock = await mockCoolify({ 'POST /api/v1/applications/abc/restart': { status: 200, json: { message: 'queued', deployment_uuid: 'd1' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('restart_application', { uuid: 'abc', confirm: 'restart application abc', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'accepted');
  assert.equal(env.data.deployment_uuid, 'd1');
});

test('stop_application: docker_cleanup bound in confirmation and sent explicitly false', async () => {
  mock = await mockCoolify({ 'POST /api/v1/applications/abc/stop': { status: 200, json: { message: 'stopping' } } });
  cred = tmpCredential();
  // Default docker_cleanup=false; confirm must include docker_cleanup=false.
  const bad = envelopeOf(await call('stop_application', { uuid: 'abc', confirm: 'stop application abc', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(bad.reason, 'confirmation_mismatch');
  const ok = envelopeOf(await call('stop_application', { uuid: 'abc', confirm: 'stop application abc docker_cleanup=false', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(ok.outcome, 'accepted');
  assert.match(mock.requests[mock.requests.length - 1].query, /docker_cleanup=false/);
});

test('cancel_deployment: status returned verbatim', async () => {
  mock = await mockCoolify({ 'POST /api/v1/deployments/d1/cancel': { status: 200, json: { message: 'ok', deployment_uuid: 'd1', status: 'cancelled-by-user' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('cancel_deployment', { uuid: 'd1', confirm: 'cancel deployment d1', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'accepted');
  assert.equal(env.data.status, 'cancelled-by-user');
});

test('delete_application_env: deletes by exact uuid; same-key preview var remaining is not a false failure', async () => {
  const before = [{ uuid: 'E1', key: 'FOO', is_preview: false }, { uuid: 'E2', key: 'FOO', is_preview: true }];
  const after = [{ uuid: 'E2', key: 'FOO', is_preview: true }];
  let getCount = 0;
  mock = await mockCoolify({
    'GET /api/v1/applications/abc/envs': () => { getCount += 1; return { status: 200, json: getCount === 1 ? before : after }; },
    'DELETE /api/v1/applications/abc/envs/E1': { status: 200, json: { message: 'deleted' } },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('delete_application_env', { uuid: 'abc', env_uuid: 'E1', confirm: 'delete env E1 of application abc', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.data.deleted, true);
});

test('delete_application_env: env uuid absent before delete -> not_found (not a false success)', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications/abc/envs': { status: 200, json: [{ uuid: 'OTHER', key: 'X' }] } });
  cred = tmpCredential();
  const env = envelopeOf(await call('delete_application_env', { uuid: 'abc', env_uuid: 'E1', confirm: 'delete env E1 of application abc', credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'not_found');
});

test('delete_application: confirmation binds all flags; row gone -> deleted', async () => {
  let getCount = 0;
  mock = await mockCoolify({
    'GET /api/v1/applications/abc': () => { getCount += 1; return getCount === 1 ? { status: 200, json: { uuid: 'abc' } } : { status: 404, json: { message: 'gone' } }; },
    'DELETE /api/v1/applications/abc': { status: 200, json: { message: 'Application deleted.' } },
  });
  cred = tmpCredential();
  const confirm = 'delete application abc delete_configurations=false delete_volumes=false delete_connected_networks=false docker_cleanup=false';
  const env = envelopeOf(await call('delete_application', { uuid: 'abc', confirm, credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.data.deleted, true);
  // All four flags sent explicitly false.
  const del = mock.requests.find((r) => r.method === 'DELETE');
  assert.match(del.query, /delete_configurations=false/);
  assert.match(del.query, /delete_volumes=false/);
  assert.match(del.query, /delete_connected_networks=false/);
  assert.match(del.query, /docker_cleanup=false/);
});

test('delete_application: row still present after delete -> accepted/pending, not a false deleted', async () => {
  mock = await mockCoolify({
    'GET /api/v1/applications/abc': { status: 200, json: { uuid: 'abc' } },
    'DELETE /api/v1/applications/abc': { status: 200, json: { message: 'queued' } },
  });
  cred = tmpCredential();
  const confirm = 'delete application abc delete_configurations=false delete_volumes=false delete_connected_networks=false docker_cleanup=false';
  const env = envelopeOf(await call('delete_application', { uuid: 'abc', confirm, credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'accepted');
  assert.equal(env.verification, 'pending');
});

test('delete_application: 404 before mutation -> not_found (not a successful deletion)', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications/abc': { status: 404, json: { message: 'nope' } } });
  cred = tmpCredential();
  const confirm = 'delete application abc delete_configurations=false delete_volumes=false delete_connected_networks=false docker_cleanup=false';
  const env = envelopeOf(await call('delete_application', { uuid: 'abc', confirm, credential_file: cred.path }, { url: mock.url, writes: 'full' }));
  assert.equal(env.outcome, 'failed');
  assert.equal(env.reason, 'not_found');
  assert.ok(!mock.requests.some((r) => r.method === 'DELETE'));
});
