// vbcdx.json is how `vbcdx install tool` registers this package. It is
// checked with the installer's own validator (vendored under test/vendor/vbcdx until
// @vbcdx/vbcdx is published), and kept true to this package: the same service and
// contract as the manifest, a bin package.json ships, and exactly the settings the source
// reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../src/manifest.js';
import { createHash } from 'node:crypto';
import { validateToolDeclaration } from './vendor/vbcdx/src/install/tool-declaration.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const decl = JSON.parse(readFileSync(join(root, 'vbcdx.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = buildManifest();

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}

test("vbcdx.json passes the vbcdx installer's own validator", () => {
  assert.deepEqual(validateToolDeclaration(decl, { pkg }), { ok: true, errors: [] });
});

test('vbcdx.json is checked by an unmodified copy of that validator', () => {
  const vendor = join(root, 'test', 'vendor', 'vbcdx');
  const listed = readFileSync(join(vendor, 'SOURCE'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l));
  assert.equal(listed.length, 4);
  for (const line of listed) {
    const [hash, file] = line.split('  ');
    assert.equal(createHash('sha256').update(readFileSync(join(vendor, file))).digest('hex'), hash, file);
  }
});

test('vbcdx.json names the service and contract the manifest reports', () => {
  assert.equal(decl.server_name, manifest.service);
  assert.equal(decl.contract, manifest.contract);
});

test('vbcdx.json starts a bin this package ships, and the package ships the declaration', () => {
  assert.ok(Object.keys(pkg.bin).includes(decl.stdio.bin));
  assert.deepEqual(decl.stdio.args, ['mcp']);
  assert.deepEqual(decl.http.args, ['serve']);
  assert.deepEqual(decl.manifest.args, ['manifest']);
  assert.ok(pkg.files.includes('vbcdx.json'));
});

test('vbcdx.json lists exactly the VBCDX_COOLIFY_* settings the source reads', () => {
  const read = new Set();
  for (const f of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'bin'))]) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bVBCDX_COOLIFY_[A-Z_]+[A-Z]\b/g)) read.add(m[0]);
  }
  assert.deepEqual(decl.env.map((e) => e.name).sort(), [...read].sort());
  assert.ok(decl.env.map((e) => e.name).includes(decl.http.port_env));
  assert.deepEqual(decl.env.filter((e) => e.required).map((e) => e.name), ['VBCDX_COOLIFY_URL']);
  assert.ok(decl.env.every((e) => e.kind === 'config'), 'credentials never come from the environment');
});

test('vbcdx.json marks exactly the network-mode settings as read in http mode only, so no stdio entry carries them', () => {
  // vbcdx writes only stdio-mode settings into a harness entry; an unset
  // network setting there would reach the stdio server as a literal ${VAR} under Hermes.
  const httpOnly = decl.env.filter((e) => e.modes !== undefined);
  for (const e of httpOnly) assert.deepEqual(e.modes, ['http'], e.name);
  assert.deepEqual(httpOnly.map((e) => e.name).sort(), [
    'VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS', 'VBCDX_COOLIFY_HTTP_HOST', 'VBCDX_COOLIFY_HTTP_PORT',
    'VBCDX_COOLIFY_TLS_CERT', 'VBCDX_COOLIFY_TLS_KEY',
  ]);
  for (const e of decl.env) assert.equal(e.description.startsWith('Network mode only'), e.modes !== undefined, e.name);
});

test('vbcdx.json declares the per-call credential argument every authenticated tool takes', () => {
  assert.deepEqual(decl.credential_file, { argument: 'credential_file' });
  for (const t of manifest.tools) {
    const takesIt = Object.keys(t.inputSchema.properties || {}).includes('credential_file');
    // Only a public tool (health: Coolify's unauthenticated endpoint) goes without one.
    assert.equal(takesIt, !t.required_permissions.includes('public'), t.name);
  }
});
