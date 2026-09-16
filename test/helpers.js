// Shared test helpers: a programmable mock Coolify server, a real credential file
// with correct POSIX permissions, and a thin wrapper over executeTool.

import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../src/registry.js';

/**
 * Start a mock Coolify HTTP server. `routes` maps `"METHOD /api/v1/path"` (path
 * without query) to a responder `{ status, json?, text?, headers?, delayMs? }` or
 * a function `(req, bodyString, url) => responder`. Records every request.
 */
export function mockCoolify(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
      let responder = routes[key];
      if (typeof responder === 'function') responder = responder(req, body, url);
      if (!responder) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found in mock' }));
        return;
      }
      const send = () => {
        const headers = { ...(responder.headers || {}) };
        let payload = '';
        if (responder.json !== undefined) {
          headers['content-type'] = headers['content-type'] || 'application/json';
          payload = JSON.stringify(responder.json);
        } else if (responder.text !== undefined) {
          headers['content-type'] = headers['content-type'] || 'text/html';
          payload = responder.text;
        }
        res.writeHead(responder.status || 200, headers);
        if (responder.raw) { res.end(responder.raw); return; }
        res.end(payload);
      };
      if (responder.delayMs) setTimeout(send, responder.delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Create a credential file with correct permissions in a fresh 0700 directory.
 * Returns { path, dir, cleanup }.
 */
export function tmpCredential({ role = 'devops-agent', token = 'TEST-TOKEN-abc123', body } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vbcdx-cred-'));
  chmodSync(dir, 0o700);
  const path = join(dir, `${role}.env`);
  const content = body != null ? body : `VBCDX_AGENTS_ROLE=${role}\nVBCDX_AGENTS_TOKEN=${token}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Call a tool through the full harness with a given environment. */
export function call(name, args, { url, writes = 'off', timeoutMs, env = {} } = {}) {
  const fullEnv = {
    ...env,
    VBCDX_COOLIFY_URL: url,
    VBCDX_COOLIFY_WRITES: writes,
  };
  if (timeoutMs != null) fullEnv.VBCDX_COOLIFY_TIMEOUT_MS = String(timeoutMs);
  return executeTool(name, args, { env: fullEnv });
}

/** The structuredContent of a tool result. */
export function envelopeOf(result) {
  return result.structuredContent;
}
