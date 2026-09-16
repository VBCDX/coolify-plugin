#!/usr/bin/env node
// Executable entrypoint. Keeps process wiring out of the CLI logic so the CLI is
// unit-testable.

import { runCli } from '../src/cli.js';

runCli(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    // Never let a raw stack with a possible secret reach stdout; diagnostics go
    // to stderr and we exit nonzero.
    process.stderr.write(`vbcdx-coolify: fatal: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
