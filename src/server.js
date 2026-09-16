// MCP stdio server (§1, §3).
//
// The full tool catalog is exposed even without service settings or credentials,
// so discovery always works. Only protocol frames go to stdout; every diagnostic
// goes to stderr. EOF/SIGTERM/cancellation stop in-flight work and clean up.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTRACT, SERVICE } from './contract.js';
import { loadConfig } from './config.js';
import { executeTool, listTools } from './registry.js';
import { packageVersion } from './version.js';

/** Build the tools/list payload from the registry. */
function toolListPayload() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: {
      readOnlyHint: t.effect === 'read',
      destructiveHint: t.effect === 'destructive',
    },
    _meta: {
      'vbcdx.coolify/effect': t.effect,
      'vbcdx.coolify/required_permissions': t.required_permissions,
    },
  }));
}

/**
 * Create and start the MCP server on stdio.
 * @returns {Promise<{ server: Server, transport: StdioServerTransport, close: () => Promise<void> }>}
 */
export async function startServer() {
  const server = new Server(
    { name: `@vbcdx/coolify-plugin (${SERVICE})`, version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolListPayload() }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args || {}, { env: process.env, signal: extra?.signal });
  });

  // One-time trusted-network HTTP notice, without printing any input value.
  const config = loadConfig(process.env);
  if (config.insecure) {
    process.stderr.write('[coolify] VBCDX_COOLIFY_URL uses plain HTTP; proceeding on the assumption of a trusted network. TLS verification is never disabled.\n');
  }
  process.stderr.write(`[coolify] MCP server ready (contract ${CONTRACT}).\n`);

  const transport = new StdioServerTransport();
  // EOF on stdin (the harness went away) stops the server and cleans up.
  transport.onclose = () => process.exit(0);
  await server.connect(transport);

  const close = async () => {
    try {
      await server.close();
    } catch {
      // ignore
    }
  };

  const onSignal = () => {
    close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  return { server, transport, close };
}
