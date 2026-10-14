// docs/contract.md publishes the contract this package implements. Its tool catalog must
// name exactly the tools the manifest has, with the same effect and permissions, and state
// the same count, so the published contract cannot drift from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../src/manifest.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = readFileSync(join(root, 'docs', 'contract.md'), 'utf8');
const manifest = buildManifest();

test('docs/contract.md names the contract the manifest reports', () => {
  assert.ok(contract.split('\n')[0].includes(`\`${manifest.contract}\``));
});

test('docs/contract.md lists every tool, with its effect and permissions, exactly as the manifest does', () => {
  const rows = new Map();
  for (const line of contract.split('\n')) {
    const m = /^\| `([a-z_]+)` \|.*\| (read|write|destructive); ([^|]+) \|$/.exec(line);
    if (m) rows.set(m[1], { effect: m[2], scopes: m[3].split(',').map((s) => s.trim()) });
  }
  assert.deepEqual([...rows.keys()].sort(), manifest.tools.map((t) => t.name).sort());
  for (const t of manifest.tools) {
    assert.deepEqual(rows.get(t.name), { effect: t.effect, scopes: t.required_permissions }, t.name);
  }
  assert.ok(contract.includes(`There are ${manifest.tools.length} tools.`));
});

test('every section a source comment cites exists in docs/contract.md', () => {
  const cited = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) for (const m of readFileSync(p, 'utf8').matchAll(/contract §(\d+)/g)) cited.add(Number(m[1]));
    }
  };
  walk(join(root, 'src'));
  assert.ok(cited.size > 0);
  for (const n of cited) assert.match(contract, new RegExp(`^## ${n}\\. `, 'm'), `section ${n}`);
});
