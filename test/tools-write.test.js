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

const CREATE_ARGS = {
  project_uuid: 'p1', server_uuid: 's1', environment_name: 'production',
  git_repository: 'https://github.com/vbcdx/example', git_branch: 'main', build_pack: 'nixpacks',
};

test('write gate: writes=off refuses a write before any request', async () => {
  mock = await mockCoolify({});
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application', { ...CREATE_ARGS, credential_file: cred.path }, { url: mock.url, writes: 'off' }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'write_gate_disabled');
  assert.equal(mock.requests.length, 0);
});

test('create_application: sends instant_deploy=false and verifies by read-back', async () => {
  mock = await mockCoolify({
    'POST /api/v1/applications/public': { status: 201, json: { uuid: 'new1' } },
    'GET /api/v1/applications/new1': { status: 200, json: { uuid: 'new1', name: 'x', git_repository: CREATE_ARGS.git_repository, git_branch: 'main', build_pack: 'nixpacks' } },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application', { ...CREATE_ARGS, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.verification, 'confirmed');
  assert.equal(env.data.uuid, 'new1');
  const body = JSON.parse(mock.requests[0].body);
  assert.equal(body.instant_deploy, false);
});

test('create_application: 2xx without uuid -> indeterminate', async () => {
  mock = await mockCoolify({ 'POST /api/v1/applications/public': { status: 201, json: {} } });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application', { ...CREATE_ARGS, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'indeterminate');
  assert.equal(env.reason, 'indeterminate_write');
});

test('create_application: read-back inaccessible -> unverified (deploy/write-only token)', async () => {
  mock = await mockCoolify({
    'POST /api/v1/applications/public': { status: 201, json: { uuid: 'new1' } },
    'GET /api/v1/applications/new1': { status: 403, json: { message: 'forbidden' } },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application', { ...CREATE_ARGS, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'unverified');
  assert.equal(env.verification, 'unavailable');
});

test('create_application: exactly-one environment enforced', async () => {
  mock = await mockCoolify({});
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application', { ...CREATE_ARGS, environment_uuid: 'e1', credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'validation_failed');
});

test('deploy: accepted with deployments, no GET preflight (deploy-only token)', async () => {
  mock = await mockCoolify({ 'POST /api/v1/deploy': { status: 200, json: { deployments: [{ resource_uuid: 'r1', deployment_uuid: 'd1', message: 'queued' }] } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('deploy', { uuid: 'r1', credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'accepted');
  assert.equal(env.verification, 'pending');
  assert.equal(env.data.deployments[0].deployment_uuid, 'd1');
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'POST');
  assert.match(mock.requests[0].query, /force=false/);
});

test('deploy: 2xx without deployments list -> indeterminate', async () => {
  mock = await mockCoolify({ 'POST /api/v1/deploy': { status: 200, json: {} } });
  cred = tmpCredential();
  const env = envelopeOf(await call('deploy', { tag: 'prod', credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'indeterminate');
});

test('start_application: accepted', async () => {
  mock = await mockCoolify({ 'POST /api/v1/applications/abc/start': { status: 200, json: { deployment_uuid: 'd1', message: 'queued' } } });
  cred = tmpCredential();
  const env = envelopeOf(await call('start_application', { uuid: 'abc', credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'accepted');
  assert.equal(env.data.deployment_uuid, 'd1');
  assert.match(mock.requests[0].query, /force=false&instant_deploy=false/);
});

test('create_application_env: empty value round-trips as confirmed', async () => {
  const envs = [{ uuid: 'e1', key: 'EMPTY', value: '', is_preview: false }];
  mock = await mockCoolify({
    'POST /api/v1/applications/abc/envs': { status: 201, json: { uuid: 'e1' } },
    'GET /api/v1/applications/abc/envs': { status: 200, json: envs },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application_env', { uuid: 'abc', key: 'EMPTY', value: '', is_preview: false, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'ok');
  assert.equal(env.verification, 'confirmed');
  assert.equal(env.data.verified, true);
});

test('create_application_env: multiline value preserved and verified', async () => {
  const envs = [{ uuid: 'e1', key: 'M', value: 'a\nb', is_preview: false }];
  mock = await mockCoolify({
    'POST /api/v1/applications/abc/envs': { status: 201, json: { uuid: 'e1' } },
    'GET /api/v1/applications/abc/envs': { status: 200, json: envs },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application_env', { uuid: 'abc', key: 'M', value: 'a\nb', is_preview: false, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'ok');
  const body = JSON.parse(mock.requests[0].body);
  assert.equal(body.value, 'a\nb');
});

test('update_application_env: 204 No Content on write is not a failure', async () => {
  // A 204 (empty body) on the mutation must not be reported as a failed write.
  const envs = [{ uuid: 'e1', key: 'K', value: 'v', is_preview: false }];
  mock = await mockCoolify({
    'PATCH /api/v1/applications/abc/envs': { status: 204 },
    'GET /api/v1/applications/abc/envs': { status: 200, json: envs },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('update_application_env', { uuid: 'abc', key: 'K', value: 'v', is_preview: false, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'ok');
});

test('create_application_env: masked read-back value -> unverified, never claims verified', async () => {
  const envs = [{ uuid: 'e1', key: 'S', is_shown_once: true, is_preview: false }]; // no value returned
  mock = await mockCoolify({
    'POST /api/v1/applications/abc/envs': { status: 201, json: { uuid: 'e1' } },
    'GET /api/v1/applications/abc/envs': { status: 200, json: envs },
  });
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application_env', { uuid: 'abc', key: 'S', value: 'secretval', is_preview: false, is_shown_once: true, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'unverified');
  // The submitted secret value must not appear anywhere in the result.
  assert.ok(!JSON.stringify(env).includes('secretval'));
});

test('create_application_env: rejects unsupported write field is_buildtime', async () => {
  mock = await mockCoolify({});
  cred = tmpCredential();
  const env = envelopeOf(await call('create_application_env', { uuid: 'abc', key: 'K', value: 'v', is_preview: false, is_buildtime: true, credential_file: cred.path }, { url: mock.url, writes: 'write' }));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.reason, 'validation_failed');
});
