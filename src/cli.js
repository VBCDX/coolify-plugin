// CLI dispatch (§1).
//
//   vbcdx-coolify mcp        stdio MCP server (no secret/URL/role/credential CLI options)
//   vbcdx-coolify manifest   deterministic nonsecret JSON tool contract (no network)
//   vbcdx-coolify --help     usage
//   vbcdx-coolify --version  version
//
// Unknown command or options exit 2. The mcp and manifest commands take no
// options: credentials and endpoints are never accepted as command-line args.

import { CONTRACT } from './contract.js';
import { manifestJson } from './manifest.js';
import { packageVersion } from './version.js';

const USAGE = `vbcdx-coolify — MCP server for a bounded, write-controlled subset of the Coolify v4 API (contract ${CONTRACT}).

Usage:
  vbcdx-coolify mcp         Start the stdio MCP server.
  vbcdx-coolify manifest    Print the deterministic JSON tool contract and exit.
  vbcdx-coolify --help      Show this help and exit.
  vbcdx-coolify --version   Print the version and exit.

Configuration is read from the environment (never from CLI options):
  VBCDX_COOLIFY_URL         Coolify instance URL (required for any API call).
  VBCDX_COOLIFY_WRITES      off (default) | write | full.
  VBCDX_COOLIFY_TIMEOUT_MS  Total per-call budget, 1000-120000 (default 30000).

Each tool except 'health' takes an explicit absolute credential_file argument at
call time; there is no token or role CLI option.`;

/**
 * Run the CLI. Returns an exit code; for `mcp` it resolves only when the server
 * stops.
 *
 * @param {string[]} argv arguments after `node script`
 * @param {{ startServer?: () => Promise<any> }} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv, deps = {}) {
  const args = argv.slice();

  // Top-level flags take precedence and accept no command.
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    process.stdout.write(packageVersion() + '\n');
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === 'manifest') {
    if (rest.length > 0) {
      process.stderr.write('manifest takes no options.\n');
      return 2;
    }
    // Only protocol/command output on stdout; the manifest is the command output.
    process.stdout.write(manifestJson() + '\n');
    return 0;
  }

  if (command === 'mcp') {
    if (rest.length > 0) {
      process.stderr.write('mcp takes no options; configuration comes from the environment.\n');
      return 2;
    }
    const start = deps.startServer || (await import('./server.js')).startServer;
    await start();
    // The server runs until stdin closes or a signal arrives; keep the process
    // alive by returning a promise that never resolves here. The transport's
    // close handler exits the process.
    await new Promise(() => {});
    return 0;
  }

  if (command === undefined) {
    process.stderr.write('No command given.\n\n' + USAGE + '\n');
    return 2;
  }

  process.stderr.write(`Unknown command "${command}".\n\n` + USAGE + '\n');
  return 2;
}
