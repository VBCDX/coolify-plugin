import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'vbcdx-coolify.js');

async function mockHealth() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/v1/health') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('OK'); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('MCP: initialize, tools/list is complete without credentials, health call works', async () => {
  const mock = await mockHealth();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    env: { ...process.env, VBCDX_COOLIFY_URL: mock.url, VBCDX_COOLIFY_WRITES: 'off' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 27);

  const res = await client.callTool({ name: 'health', arguments: {} });
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.outcome, 'ok');

  await client.close();
  await mock.close();
});

test('MCP: a call without credentials returns an actionable error, not a crash', async () => {
  const mock = await mockHealth();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    env: { ...process.env, VBCDX_COOLIFY_URL: mock.url, VBCDX_COOLIFY_WRITES: 'off' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const res = await client.callTool({ name: 'list_applications', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.reason, 'validation_failed');
  await client.close();
  await mock.close();
});

test('server writes diagnostics to stderr, not stdout (protocol-only stdout)', async () => {
  // If the server wrote a diagnostic to stdout it would corrupt the JSON-RPC
  // stream and the client handshake would fail. A successful handshake with an
  // insecure (http) URL — which triggers the one-time notice — proves the notice
  // went to stderr.
  const mock = await mockHealth();
  let stderrText = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    env: { ...process.env, VBCDX_COOLIFY_URL: mock.url, VBCDX_COOLIFY_WRITES: 'off' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => { stderrText += d.toString(); });
  await client.listTools();
  await new Promise((r) => setTimeout(r, 50));
  assert.match(stderrText, /plain HTTP|MCP server ready/);
  await client.close();
  await mock.close();
});
