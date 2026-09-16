import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from '../src/manifest.js';
import { listTools, toolCount } from '../src/registry.js';

test('manifest has the fixed header fields', () => {
  const m = buildManifest();
  assert.equal(m.schema_version, 1);
  assert.equal(m.service, 'coolify');
  assert.equal(m.contract, 'vbcdx.coolify/1');
  assert.equal(typeof m.package_version, 'string');
});

test('manifest lists exactly 27 tools, name-sorted', () => {
  const m = buildManifest();
  assert.equal(m.tools.length, 27);
  assert.equal(toolCount(), 27);
  const names = m.tools.map((t) => t.name);
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

test('every tool declares the required manifest fields', () => {
  const m = buildManifest();
  for (const t of m.tools) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.inputSchema, 'object');
    assert.equal(typeof t.outputSchema, 'object');
    assert.ok(['read', 'write', 'destructive'].includes(t.effect));
    assert.ok(Array.isArray(t.required_permissions));
  }
});

test('every non-health tool requires credential_file', () => {
  const m = buildManifest();
  for (const t of m.tools) {
    if (t.name === 'health') {
      assert.ok(!('credential_file' in (t.inputSchema.properties || {})));
    } else {
      assert.ok(t.inputSchema.properties.credential_file, `${t.name} missing credential_file`);
      assert.ok((t.inputSchema.required || []).includes('credential_file'), `${t.name} credential_file not required`);
    }
  }
});

test('destructive tools require confirm', () => {
  const m = buildManifest();
  const destructive = m.tools.filter((t) => t.effect === 'destructive').map((t) => t.name);
  assert.deepEqual(destructive.sort(), ['cancel_deployment', 'delete_application', 'delete_application_env', 'restart_application', 'stop_application']);
  for (const t of m.tools) {
    if (t.effect === 'destructive') {
      assert.ok((t.inputSchema.required || []).includes('confirm'), `${t.name} confirm not required`);
    }
  }
});

test('manifest contains no filesystem path, install root, or native prefix', () => {
  const json = JSON.stringify(buildManifest());
  assert.ok(!json.includes('/home/'));
  assert.ok(!json.includes('node_modules'));
  assert.ok(!json.includes('mcp__coolify'));
});

test('every listTools output schema is the envelope schema', () => {
  for (const t of listTools()) {
    assert.deepEqual(t.outputSchema.required, ['outcome', 'effect', 'request', 'verification']);
  }
});
