// Read the package version from package.json at runtime, so the manifest and the
// --version output cannot drift from the published version.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached = null;

export function packageVersion() {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  cached = pkg.version;
  return cached;
}
