import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockCoolify, tmpCredential, call, envelopeOf } from './helpers.js';

let mock;
const creds = [];
afterEach(async () => {
  if (mock) await mock.close();
  while (creds.length) creds.pop().cleanup();
  mock = null;
});

const SECRET = 'sk-THIS-MUST-NEVER-LEAK-0001';

test('token never appears in a 401 result', async () => {
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 401, json: { message: 'no' } } });
  const c = tmpCredential({ token: SECRET });
  creds.push(c);
  const result = await call('list_applications', { credential_file: c.path }, { url: mock.url });
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!result.content[0].text.includes(SECRET));
});

test('token never appears when the upstream echoes it in an error body', async () => {
  // Even if the instance echoes the token, our projections/messages never carry
  // the raw upstream body, and the scrub is a backstop.
  mock = await mockCoolify({ 'GET /api/v1/applications': { status: 500, json: { message: `boom for ${SECRET}` } } });
  const c = tmpCredential({ token: SECRET });
  creds.push(c);
  const result = await call('list_applications', { credential_file: c.path }, { url: mock.url });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('Authorization header carries the token but the token is not in output', async () => {
  mock = await mockCoolify({ 'GET /api/v1/version': { status: 200, text: 'v4' } });
  const c = tmpCredential({ token: SECRET });
  creds.push(c);
  const result = await call('version', { credential_file: c.path }, { url: mock.url });
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('concurrent calls with separate credential files stay isolated', async () => {
  mock = await mockCoolify({ 'GET /api/v1/version': (req) => ({ status: 200, text: 'v4' }) });
  const cA = tmpCredential({ token: 'TOKEN-AAAA' });
  const cB = tmpCredential({ token: 'TOKEN-BBBB' });
  creds.push(cA, cB);
  const [rA, rB] = await Promise.all([
    call('version', { credential_file: cA.path }, { url: mock.url }),
    call('version', { credential_file: cB.path }, { url: mock.url }),
  ]);
  assert.equal(envelopeOf(rA).outcome, 'ok');
  assert.equal(envelopeOf(rB).outcome, 'ok');
  const auths = mock.requests.map((r) => r.headers.authorization).sort();
  assert.deepEqual(auths, ['Bearer TOKEN-AAAA', 'Bearer TOKEN-BBBB']);
});
