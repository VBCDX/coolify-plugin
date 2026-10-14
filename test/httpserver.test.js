// Network mode (serve). Real MCP HTTP client against runHttpServer on an
// ephemeral port, with the programmable mock Coolify from helpers.js as upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http';
import { runHttpServer, MAX_BODY_BYTES, loadHttpOptions, parseAllowedOrigins, originAllowed } from '../src/httpserver.js';
import { scrub } from '../src/redact.js';
import { runCli } from '../src/cli.js';
import { listTools } from '../src/registry.js';
import { mockCoolify, envelopeOf } from './helpers.js';

const TOKEN = 'SECRET-coolify-token-xyz789';

async function withServe(routes, fn, { writes = 'off', env: envOver = {}, allowedOrigins } = {}) {
  const mock = await mockCoolify(routes);
  const env = { VBCDX_COOLIFY_URL: mock.url, VBCDX_COOLIFY_WRITES: writes, ...envOver };
  const logs = [];
  const srv = await runHttpServer({ env, http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null, allowedOrigins }, log: (m) => logs.push(m), installSignals: false });
  const base = `http://127.0.0.1:${srv.port}`;
  const client = async (authorization) => {
    const headers = authorization ? { Authorization: authorization } : {};
    const c = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    return c;
  };
  try {
    await fn({ base, mock, client, logs, port: srv.port });
  } finally {
    await srv.close();
    await mock.close();
  }
}

test('serve: /healthz, 404 for other paths, 405 for GET /mcp', async () => {
  await withServe({}, async ({ base }) => {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    const body = await h.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.tools, listTools().length);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const g = await fetch(`${base}/mcp`);
    assert.equal(g.status, 405);
    assert.equal(g.headers.get('allow'), 'POST');
  });
});

test('serve: tools/list works without a credential and drops credential_file', async () => {
  await withServe({}, async ({ client }) => {
    const c = await client();
    const { tools } = await c.listTools();
    assert.equal(tools.length, listTools().length);
    for (const t of tools) {
      assert.equal(t.inputSchema.properties?.credential_file, undefined, t.name);
      assert.ok(!(t.inputSchema.required || []).includes('credential_file'), t.name);
    }
    await c.close();
  });
  // The stdio catalogue (and so the manifest) is unchanged.
  assert.ok(listTools().filter((t) => t.name !== 'health').every((t) => t.inputSchema.required.includes('credential_file')));
});

test('serve: a call without Authorization is refused before any Coolify request', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const c = await client();
    const r = await c.callTool({ name: 'version', arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(envelopeOf(r).reason, 'credential_missing');
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

test('serve: a malformed or non-Bearer header is refused and never echoed', async () => {
  for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', `Bearer ${TOKEN} extra`]) {
    await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
      const c = await client(header);
      const r = await c.callTool({ name: 'version', arguments: {} });
      assert.equal(r.isError, true, header);
      assert.equal(envelopeOf(r).reason, 'credential_malformed', header);
      assert.doesNotMatch(JSON.stringify(r), /dXNlcjpwYXNz|SECRET-coolify/);
      assert.equal(mock.requests.length, 0);
      await c.close();
    });
  }
});

test('serve: the Bearer token is forwarded upstream and never appears in results or logs', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2\n' } }, async ({ client, mock, logs }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'version', arguments: {} });
    assert.notEqual(r.isError, true);
    assert.equal(envelopeOf(r).data.version, '4.1.2');
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(r), /SECRET-coolify/);
    assert.doesNotMatch(logs.join('\n'), /SECRET-coolify/);
    await c.close();
  });
});

test('serve: a credential_file argument is rejected over HTTP', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'version', arguments: { credential_file: '/etc/passwd' } });
    assert.equal(r.isError, true);
    // the real reason, not just any refusal
    assert.equal(envelopeOf(r).reason, 'validation_failed');
    assert.match(envelopeOf(r).message, /credential_file/);
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

test('serve: the write gate still runs first (writes=off refuses before the credential)', async () => {
  await withServe({}, async ({ client, mock }) => {
    const c = await client(); // no credential at all
    const r = await c.callTool({ name: 'start_application', arguments: { uuid: 'abc' } });
    assert.equal(r.isError, true);
    assert.equal(envelopeOf(r).reason, 'write_gate_disabled');
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

// The other gates also refuse before the Authorization header
// is read. None of these calls sends a header, so a credential-first order would
// answer credential_missing instead.
test('serve: a wrong destructive confirmation is refused before the credential', async () => {
  await withServe({}, async ({ client, mock }) => {
    const c = await client();
    const r = await c.callTool({ name: 'restart_application', arguments: { uuid: 'abc', confirm: 'restart application xyz' } });
    assert.equal(envelopeOf(r).reason, 'confirmation_mismatch');
    assert.equal(mock.requests.length, 0);
    await c.close();
  }, { writes: 'full' });
});

test('serve: an unconfigured server is refused before the credential', async () => {
  await withServe({}, async ({ client, mock }) => {
    const c = await client();
    const r = await c.callTool({ name: 'version', arguments: {} });
    assert.equal(envelopeOf(r).reason, 'server_not_configured');
    assert.equal(mock.requests.length, 0);
    await c.close();
  }, { env: { VBCDX_COOLIFY_URL: undefined } });
});

// The header token is released from the redactor when the call ends.
test('serve: the Bearer token is no longer redacted once its call has finished', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client }) => {
    const c = await client(`Bearer ${TOKEN}`);
    assert.notEqual((await c.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(scrub(TOKEN), TOKEN);
    await c.close();
  });
});

// The per-call scope still redacts the call's OWN token: an upstream that echoes it
// back must not put it in the result (the per-call redaction property).
test('serve: a caller\'s own token echoed by Coolify is redacted from its result', async () => {
  await withServe({ 'GET /api/v1/version': { text: TOKEN } }, async ({ client }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'version', arguments: {} });
    const text = r.content.map((x) => x.text).join('\n');
    assert.doesNotMatch(text, /SECRET-coolify/);
    assert.match(text, /<redacted>/);
    // and the structured result, which Hermes and other MCP clients read
    assert.doesNotMatch(JSON.stringify(r.structuredContent), /SECRET-coolify/);
    await c.close();
  });
});

// The text rendering once printed request.path unscrubbed, and a caller's
// argument can land there (list_applications puts `tag` in the query string).
test('serve: a caller\'s own token in a request argument is redacted from the text and structuredContent', async () => {
  await withServe({ 'GET /api/v1/applications': { json: [] } }, async ({ client }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'list_applications', arguments: { tag: TOKEN } });
    assert.notEqual(r.isError, true);
    const text = r.content.map((x) => x.text).join('\n');
    assert.match(text, /request: GET .*<redacted>/);
    assert.doesNotMatch(text, /SECRET-coolify/);
    assert.doesNotMatch(JSON.stringify(r.structuredContent), /SECRET-coolify/);
    await c.close();
  });
});

// A token is scrubbed from its own call's output only. Caller A sends a
// Bearer value that appears in caller B's result; while A's request is in flight,
// B's result must still show it.
test('serve: one caller\'s Bearer value never redacts another caller\'s concurrent result', async () => {
  let aArrived;
  const aSeen = new Promise((r) => { aArrived = r; });
  // A's upstream answer is held until B's result is in: a fixed delay let a
  // slow B finish after A and pass with the bug restored.
  let releaseA;
  const aReleased = new Promise((r) => { releaseA = r; });
  const routes = {
    'GET /api/v1/version': (req) => {
      if (req.headers.authorization === 'Bearer 4.1.2') {
        aArrived();
        return { status: 401, json: { message: 'Unauthenticated.' }, release: aReleased };
      }
      return { text: '4.1.2' };
    },
  };
  await withServe(routes, async ({ client }) => {
    const a = await client('Bearer 4.1.2');
    const b = await client(`Bearer ${TOKEN}`);
    let aSettled = false;
    const pendingA = a.callTool({ name: 'version', arguments: {} }).finally(() => { aSettled = true; });
    await aSeen; // A's token is registered and its call is in flight
    let rb;
    try {
      rb = await b.callTool({ name: 'version', arguments: {} });
      assert.equal(aSettled, false, "A's call must still be in flight when B's result arrives");
    } finally {
      releaseA(); // never leave A's request held, even when an assert above fails
    }
    const text = rb.content.map((x) => x.text).join('\n');
    assert.match(text, /4\.1\.2/);
    assert.doesNotMatch(text, /<redacted>/);
    const ra = await pendingA;
    assert.equal(ra.isError, true);
    await a.close();
    await b.close();
  });
});

// The MCP transport spec's MUST on Origin (DNS rebinding). Raw fetch,
// because the SDK client never sends an Origin.
function rawVersionCall(port, origin) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
  if (origin !== undefined) headers.origin = origin;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'version', arguments: {} } }),
  });
}

test('serve: any request carrying an Origin is refused with 403 before any Coolify request', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    for (const origin of ['http://evil.example', 'http://127.0.0.1:8080', 'null', '']) {
      const r = await rawVersionCall(port, origin);
      assert.equal(r.status, 403, origin);
      const text = await r.text();
      assert.match(text, /Origin not allowed/);
      if (origin.includes('://')) assert.doesNotMatch(text, new RegExp(origin.replace(/[.]/g, '\\.')));
    }
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { origin: 'http://evil.example' } });
    assert.equal(health.status, 403);
    assert.equal(mock.requests.length, 0);
  });
});

test('serve: no Origin, or an allowed one (compared normalised), is served', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    assert.equal((await rawVersionCall(port, undefined)).status, 200);
    assert.equal((await rawVersionCall(port, 'https://CHAT.example.com:443')).status, 200);
    assert.equal((await rawVersionCall(port, 'https://chat.example.com.evil.example')).status, 403);
    assert.equal((await rawVersionCall(port, 'http://chat.example.com')).status, 403);
    assert.equal(mock.requests.length, 2);
  }, { allowedOrigins: ['https://chat.example.com'] });
});

test('serve: VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS is parsed strictly and a bad entry stops startup', async () => {
  assert.deepEqual(parseAllowedOrigins(undefined), { allowedOrigins: [], originsError: null });
  assert.deepEqual(parseAllowedOrigins(' https://a.example , http://b.example:8080 ,').allowedOrigins, ['https://a.example', 'http://b.example:8080']);
  for (const bad of ['a.example', 'null', 'ftp://a.example', 'https://a.example/path', 'https://u:p@a.example', 'https://a.example?x=1', 'https://*.example.com', 'http://*:8080']) {
    assert.match(parseAllowedOrigins(bad).originsError, /ALLOWED_ORIGINS/, bad);
  }
  assert.deepEqual(loadHttpOptions({ VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS: 'https://a.example' }).allowedOrigins, ['https://a.example']);
  assert.equal(originAllowed(undefined, []), true);
  assert.equal(originAllowed('https://a.example', []), false);
  // A server that starts by mistake is closed again, so the test fails instead of hanging.
  const outcome = await runHttpServer({ env: {}, http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null, originsError: 'VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS bad' }, log: () => {}, installSignals: false })
    .then(async (srv) => { await srv.close(); return 'started'; }, (err) => err);
  assert.ok(outcome instanceof Error, 'serve must not start with a bad allow-list');
  assert.match(outcome.message, /ALLOWED_ORIGINS/);
});

test('cli: serve/healthcheck reject options; healthcheck probes a running serve', async () => {
  assert.equal(await runCli(['serve', '--port=1']), 2);
  assert.equal(await runCli(['healthcheck', 'x']), 2);
  await withServe({}, async ({ port }) => {
    const prev = process.env.VBCDX_COOLIFY_HTTP_PORT;
    process.env.VBCDX_COOLIFY_HTTP_PORT = String(port);
    try {
      assert.equal(await runCli(['healthcheck']), 0);
    } finally {
      if (prev === undefined) delete process.env.VBCDX_COOLIFY_HTTP_PORT;
      else process.env.VBCDX_COOLIFY_HTTP_PORT = prev;
    }
  });
});

test('serve: one server keeps each caller\'s token to its own request (never cached)', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const a = await client('Bearer TOKEN-A');
    assert.notEqual((await a.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer TOKEN-A');
    // the next caller sends no header: refused, and A's token is not reused
    const anon = await client();
    const r = await anon.callTool({ name: 'version', arguments: {} });
    assert.equal(envelopeOf(r).reason, 'credential_missing');
    assert.equal(mock.requests.length, 1);
    // a third caller with another token: upstream sees that token, not A's
    const b = await client('Bearer TOKEN-B');
    assert.notEqual((await b.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].headers.authorization, 'Bearer TOKEN-B');
    // and A again, after B
    assert.notEqual((await a.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests[2].headers.authorization, 'Bearer TOKEN-A');
    for (const c of [a, anon, b]) await c.close();
  });
});

// Raw POST: resolves with the response even if the server closes before the
// whole body was sent (that is the point of the cap).
function rawPost(port, { chunks, contentLength }) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer TOKEN-A' };
    if (contentLength !== undefined) headers['content-length'] = String(contentLength);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', () => resolve({ status: res.statusCode, body }));
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    req.on('error', (err) => { if (!answered) reject(err); });
    (async () => {
      for (const c of chunks) {
        if (req.destroyed) return;
        if (!req.write(c)) {
          await new Promise((r) => {
            const done = () => { req.off('drain', done); req.off('close', done); r(); };
            req.once('drain', done);
            req.once('close', done);
          });
        }
      }
      if (!req.destroyed) req.end();
    })();
  });
}

test('serve: an oversized body is refused with 413 before any Coolify request', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const n = Math.ceil((2 * MAX_BODY_BYTES) / chunk.length);
    const chunks = Array.from({ length: n }, () => chunk);
    // declared too large
    const declared = await rawPost(port, { chunks, contentLength: n * chunk.length });
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, -32000);
    // chunked, no Content-Length: caught while streaming
    const streamed = await rawPost(port, { chunks });
    assert.equal(streamed.status, 413);
    assert.equal(mock.requests.length, 0);
  });
});

// Stream more than the cap and never end the request: only a server that refuses
// mid-stream answers. One that buffers until 'end' and then checks the size
// (the unbounded-body bug in another form) never responds, and the bounded wait fails.
function postUnterminated(port, bytes, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer TOKEN-A' };
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      res.resume();
      done({ status: res.statusCode, requestStillOpen: !req.writableEnded });
    });
    req.on('error', () => done({ status: null, error: true }));
    const timer = setTimeout(() => done({ status: null, timedOut: true }), waitMs);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    (async () => {
      for (let sent = 0; sent < bytes && !settled; sent += chunk.length) {
        if (!req.write(chunk)) {
          await new Promise((r) => {
            const go = () => { req.off('drain', go); req.off('close', go); r(); };
            req.once('drain', go);
            req.once('close', go);
          });
        }
      }
      // deliberately no req.end()
    })();
  });
}

test('serve: an over-cap chunked body gets 413 while the request is still open', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const r = await postUnterminated(port, MAX_BODY_BYTES + 64 * 1024, 3000);
    assert.equal(r.status, 413, `expected 413 before the request ended, got ${JSON.stringify(r)}`);
    assert.equal(r.requestStillOpen, true);
    assert.equal(mock.requests.length, 0);
  });
});

test('serve: a body under the cap still works; a non-JSON body gets 400', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'version', arguments: {} } });
    // padded with whitespace to just under the cap, so the limit is not off by a lot
    const body = Buffer.from(call + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(call)));
    assert.equal(body.length, MAX_BODY_BYTES);
    const ok = await rawPost(port, { chunks: [body], contentLength: body.length });
    assert.equal(ok.status, 200);
    assert.equal(mock.requests.length, 1);
    const bad = await rawPost(port, { chunks: [Buffer.from('{not json')] });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, -32700);
    assert.equal(mock.requests.length, 1);
  });
});

test('cli: healthcheck fails (exit 1) when nothing is listening', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r)); // port now closed
  const prev = process.env.VBCDX_COOLIFY_HTTP_PORT;
  process.env.VBCDX_COOLIFY_HTTP_PORT = String(port);
  try {
    assert.equal(await runCli(['healthcheck']), 1);
  } finally {
    if (prev === undefined) delete process.env.VBCDX_COOLIFY_HTTP_PORT;
    else process.env.VBCDX_COOLIFY_HTTP_PORT = prev;
  }
});
