import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeCoolifyUrl } from '../src/config.js';

test('normalizeCoolifyUrl: bare host gets /api/v1 appended once', () => {
  assert.equal(normalizeCoolifyUrl('https://coolify.example.com').apiBase, 'https://coolify.example.com/api/v1');
});

test('normalizeCoolifyUrl: trailing /api/v1 not doubled', () => {
  assert.equal(normalizeCoolifyUrl('https://coolify.example.com/api/v1').apiBase, 'https://coolify.example.com/api/v1');
});

test('normalizeCoolifyUrl: deployment prefix preserved', () => {
  assert.equal(normalizeCoolifyUrl('https://host.example.com/coolify/').apiBase, 'https://host.example.com/coolify/api/v1');
});

test('normalizeCoolifyUrl: http is allowed and flagged insecure', () => {
  const r = normalizeCoolifyUrl('http://10.0.0.5:8000');
  assert.equal(r.apiBase, 'http://10.0.0.5:8000/api/v1');
  assert.equal(r.insecure, true);
});

test('normalizeCoolifyUrl: userinfo rejected', () => {
  assert.throws(() => normalizeCoolifyUrl('https://user:pass@host.example.com'), /credentials/);
});

test('normalizeCoolifyUrl: query rejected', () => {
  assert.throws(() => normalizeCoolifyUrl('https://host.example.com?x=1'), /query/);
});

test('normalizeCoolifyUrl: fragment rejected', () => {
  assert.throws(() => normalizeCoolifyUrl('https://host.example.com#frag'), /fragment/);
});

test('normalizeCoolifyUrl: non-http protocol rejected', () => {
  assert.throws(() => normalizeCoolifyUrl('ftp://host.example.com'), /http/);
});

test('normalizeCoolifyUrl: control characters rejected', () => {
  assert.throws(() => normalizeCoolifyUrl('https://host.example.com/\x01x'), /control/);
});

test('loadConfig: defaults', () => {
  const c = loadConfig({ VBCDX_COOLIFY_URL: 'https://x.example.com' });
  assert.equal(c.writes, 'off');
  assert.equal(c.timeoutMs, 30000);
  assert.equal(c.apiBase, 'https://x.example.com/api/v1');
  assert.equal(c.configError, null);
});

test('loadConfig: invalid write level behaves as off', () => {
  const c = loadConfig({ VBCDX_COOLIFY_URL: 'https://x.example.com', VBCDX_COOLIFY_WRITES: 'yolo' });
  assert.equal(c.writes, 'off');
  assert.equal(c.writesInvalid, true);
});

test('loadConfig: out-of-range timeout is a config error', () => {
  const c = loadConfig({ VBCDX_COOLIFY_URL: 'https://x.example.com', VBCDX_COOLIFY_TIMEOUT_MS: '999' });
  assert.ok(c.configError);
  assert.equal(c.configError.reason, 'server_not_configured');
});

test('loadConfig: missing URL is not fatal to discovery', () => {
  const c = loadConfig({});
  assert.equal(c.apiBase, null);
  assert.equal(c.urlConfigured, false);
});

test('loadConfig: no COOLIFY_ROOT_TOKEN is ever read', () => {
  const c = loadConfig({ VBCDX_COOLIFY_URL: 'https://x.example.com', COOLIFY_ROOT_TOKEN: 'x', COOLIFY_ROOT_TOKEN_NEW: 'y' });
  // Nothing in the config object should carry a token.
  assert.equal(JSON.stringify(c).includes('"x"'), false);
  assert.equal(JSON.stringify(c).includes('"y"'), false);
});
