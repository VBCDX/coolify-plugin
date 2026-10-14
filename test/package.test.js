// Packaging metadata for the public npm package: links to the public
// repository (npm provenance needs it), a supported Node floor, one author, the files a
// user needs shipped with the code, and serve listening on loopback unless told otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHttpOptions } from '../src/httpserver.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('package.json points at the public repository, its home page and its issues', () => {
  assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/VBCDX/coolify-plugin.git' });
  assert.equal(pkg.homepage, 'https://github.com/VBCDX/coolify-plugin#readme');
  assert.deepEqual(pkg.bugs, { url: 'https://github.com/VBCDX/coolify-plugin/issues' });
});

test('package.json needs a supported Node, names one author, and ships the licence, config example and declaration', () => {
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.equal(pkg.author, 'VBCDX');
  for (const f of ['LICENSE', '.env.example', 'vbcdx.json', 'README.md', 'docs']) assert.ok(pkg.files.includes(f), f);
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.scripts.lint, 'node scripts/lint.mjs');
});

test('serve listens on loopback by default; the container image sets every interface itself', () => {
  assert.equal(loadHttpOptions({}).host, '127.0.0.1');
  assert.equal(loadHttpOptions({ VBCDX_COOLIFY_HTTP_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /VBCDX_COOLIFY_HTTP_HOST=0\.0\.0\.0/);
});
