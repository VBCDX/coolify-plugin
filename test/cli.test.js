import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { packageVersion } from '../src/version.js';

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  return { restore: () => { process.stdout.write = orig; }, text: () => chunks.join('') };
}
function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  return { restore: () => { process.stderr.write = orig; }, text: () => chunks.join('') };
}

test('--version prints version, exit 0', async () => {
  const out = captureStdout();
  const code = await runCli(['--version']);
  out.restore();
  assert.equal(code, 0);
  assert.equal(out.text().trim(), packageVersion());
});

test('--help prints usage, exit 0', async () => {
  const out = captureStdout();
  const code = await runCli(['--help']);
  out.restore();
  assert.equal(code, 0);
  assert.match(out.text(), /Usage:/);
});

test('manifest prints JSON to stdout, exit 0', async () => {
  const out = captureStdout();
  const code = await runCli(['manifest']);
  out.restore();
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text());
  assert.equal(parsed.tools.length, 27);
});

test('manifest with options exits 2', async () => {
  const err = captureStderr();
  const code = await runCli(['manifest', '--extra']);
  err.restore();
  assert.equal(code, 2);
});

test('mcp with options exits 2 (no CLI credential/URL options)', async () => {
  const err = captureStderr();
  const code = await runCli(['mcp', '--url=https://x']);
  err.restore();
  assert.equal(code, 2);
});

test('unknown command exits 2', async () => {
  const err = captureStderr();
  const code = await runCli(['frobnicate']);
  err.restore();
  assert.equal(code, 2);
});

test('no command exits 2', async () => {
  const err = captureStderr();
  const code = await runCli([]);
  err.restore();
  assert.equal(code, 2);
});

test('mcp command starts the server (injected)', async () => {
  let started = false;
  // startServer is injected; the real one blocks forever, so we race a resolve.
  const p = runCli(['mcp'], { startServer: async () => { started = true; } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, true);
  // runCli's mcp path never resolves (keeps process alive); we do not await p.
  void p;
});
