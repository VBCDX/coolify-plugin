// Hermes passes an unset `${VAR}` reference through as literal text,
// so a setting that is exactly an unexpanded reference counts as unset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, withoutUnexpanded } from '../src/config.js';
import { loadHttpOptions, runHttpServer } from '../src/httpserver.js';

const URL_OK = { VBCDX_COOLIFY_URL: 'https://coolify.example.com' };

test('an unexpanded timeout takes its default instead of failing every call', () => {
  const c = loadConfig({ ...URL_OK, VBCDX_COOLIFY_TIMEOUT_MS: '${VBCDX_COOLIFY_TIMEOUT_MS}' });
  assert.equal(c.configError, null);
  assert.equal(c.timeoutMs, 30000);
});

test('an unexpanded write gate stays off without reporting an invalid mode', () => {
  const c = loadConfig({ ...URL_OK, VBCDX_COOLIFY_WRITES: '${VBCDX_COOLIFY_WRITES}' });
  assert.equal(c.writes, 'off');
  assert.equal(c.writesInvalid, false);
});

test('an unexpanded URL reads as not configured', () => {
  assert.equal(loadConfig({ VBCDX_COOLIFY_URL: ' ${VBCDX_COOLIFY_URL} ' }).urlConfigured, false);
});

test('only a whole-value reference is dropped; anything else is still checked', () => {
  assert.ok(loadConfig({ ...URL_OK, VBCDX_COOLIFY_TIMEOUT_MS: '${X}0' }).configError);
  assert.ok(loadConfig({ ...URL_OK, VBCDX_COOLIFY_TIMEOUT_MS: '$X' }).configError);
  assert.equal(loadConfig({ ...URL_OK, VBCDX_COOLIFY_WRITES: '${1X}' }).writesInvalid, true);
});

test('withoutUnexpanded touches only VBCDX_COOLIFY_* references and leaves its input alone', () => {
  const env = { VBCDX_COOLIFY_WRITES: '${A}', VBCDX_COOLIFY_URL: 'https://x.example', OTHER: '${B}' };
  assert.deepEqual(withoutUnexpanded(env), { VBCDX_COOLIFY_URL: 'https://x.example', OTHER: '${B}' });
  assert.equal(env.VBCDX_COOLIFY_WRITES, '${A}');
});

const ref = (k) => '${' + k + '}';

test('network options: unexpanded port and origins fall back to their safe defaults', () => {
  const keys = ['VBCDX_COOLIFY_HTTP_PORT', 'VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS'];
  assert.deepEqual(loadHttpOptions(Object.fromEntries(keys.map((k) => [k, ref(k)]))), loadHttpOptions({}));
  assert.equal(loadHttpOptions({}).unexpandedError, null);
});

test('network options: unexpanded TLS and bind host fail closed, and serve refuses to start', async () => {
  for (const keys of [['VBCDX_COOLIFY_TLS_CERT'], ['VBCDX_COOLIFY_TLS_KEY'], ['VBCDX_COOLIFY_HTTP_HOST'], ['VBCDX_COOLIFY_TLS_CERT', 'VBCDX_COOLIFY_TLS_KEY']]) {
    const o = loadHttpOptions(Object.fromEntries(keys.map((k) => [k, ` ${ref(k)} `])));
    const one = keys.length === 1;
    assert.equal(o.unexpandedError, `${keys.join(', ')} ${one ? 'is' : 'are'} an unexpanded \${...} reference; set ${one ? 'it' : 'them'} to a real value or leave ${one ? 'it' : 'them'} unset.`, keys.join());
    await assert.rejects(runHttpServer({ env: {}, http: o, log: () => {}, installSignals: false }), /unexpanded/);
  }
  assert.equal(loadHttpOptions({ VBCDX_COOLIFY_HTTP_HOST: '127.0.0.1' }).unexpandedError, null);
});

test('healthcheck: unexpanded TLS references report unhealthy instead of guessing a scheme', async () => {
  const { httpHealthcheck } = await import('../src/httpserver.js');
  const srv = await runHttpServer({ env: {}, http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null }, log: () => {}, installSignals: false });
  try {
    const env = { VBCDX_COOLIFY_HTTP_PORT: String(srv.port) };
    assert.equal(await httpHealthcheck({ env }), true);
    const refs = { ...env, VBCDX_COOLIFY_TLS_CERT: ref('VBCDX_COOLIFY_TLS_CERT'), VBCDX_COOLIFY_TLS_KEY: ref('VBCDX_COOLIFY_TLS_KEY') };
    assert.equal(await httpHealthcheck({ env: refs }), false);
  } finally {
    await srv.close();
  }
});
