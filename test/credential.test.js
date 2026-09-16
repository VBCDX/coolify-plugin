import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCredentialGrammar, readCredentialFile } from '../src/credential.js';
import { RefusedError } from '../src/envelope.js';

function reasonOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof RefusedError, `expected RefusedError, got ${err}`);
    return err.reason;
  }
}

test('grammar: unquoted keeps interior #, =, $ literal', () => {
  const p = parseCredentialGrammar('VBCDX_AGENTS_TOKEN = a#b=c$d\n');
  assert.equal(p.VBCDX_AGENTS_TOKEN, 'a#b=c$d');
});

test('grammar: single quotes are literal', () => {
  const p = parseCredentialGrammar("VBCDX_AGENTS_TOKEN = 'a b$c'\n");
  assert.equal(p.VBCDX_AGENTS_TOKEN, 'a b$c');
});

test('grammar: double quotes use JSON escaping', () => {
  const p = parseCredentialGrammar('VBCDX_AGENTS_TOKEN = "a\\tb"\n');
  assert.equal(p.VBCDX_AGENTS_TOKEN, 'a\tb');
});

test('grammar: comment and blank lines ignored', () => {
  const p = parseCredentialGrammar('# comment\n\n   # indented comment\nVBCDX_AGENTS_ROLE=devops-agent\n');
  assert.equal(p.VBCDX_AGENTS_ROLE, 'devops-agent');
});

test('grammar: duplicate keys rejected (case-insensitive)', () => {
  assert.throws(() => parseCredentialGrammar('VBCDX_AGENTS_TOKEN=a\nvbcdx_agents_token=b\n'), /malformed/);
});

test('grammar: malformed double quote rejected', () => {
  assert.throws(() => parseCredentialGrammar('VBCDX_AGENTS_TOKEN="unterminated\n'), /malformed/);
});

test('grammar: trailing data after quoted value rejected', () => {
  assert.throws(() => parseCredentialGrammar('VBCDX_AGENTS_TOKEN="a" trailing\n'), /malformed/);
});

test('grammar: NUL byte rejected', () => {
  assert.throws(() => parseCredentialGrammar('VBCDX_AGENTS_TOKEN=a\0b\n'), /malformed/);
});

test('readCredentialFile: not absolute -> credential_not_absolute', () => {
  assert.equal(reasonOf(() => readCredentialFile('relative/path.env')), 'credential_not_absolute');
});

test('readCredentialFile: missing -> credential_missing', () => {
  assert.equal(reasonOf(() => readCredentialFile('/nonexistent/dir/x.env')), 'credential_missing');
});

test('readCredentialFile: happy path returns role and token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'devops-agent.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=devops-agent\nVBCDX_AGENTS_TOKEN=TKN123\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  const cred = readCredentialFile(p);
  assert.equal(cred.role, 'devops-agent');
  assert.equal(cred.token, 'TKN123');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: mode 0644 -> credential_unsafe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=t\n', { mode: 0o644 });
  chmodSync(p, 0o644);
  assert.equal(reasonOf(() => readCredentialFile(p)), 'credential_unsafe');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: parent 0777 -> credential_unsafe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o777);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=t\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  assert.equal(reasonOf(() => readCredentialFile(p)), 'credential_unsafe');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: symlink file -> credential_unsafe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const real = join(dir, 'real.env');
  writeFileSync(real, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=t\n', { mode: 0o600 });
  chmodSync(real, 0o600);
  const link = join(dir, 'link.env');
  symlinkSync(real, link);
  assert.equal(reasonOf(() => readCredentialFile(link)), 'credential_unsafe');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: missing token -> credential_key_missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  assert.equal(reasonOf(() => readCredentialFile(p)), 'credential_key_missing');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: unsupported VBCDX_AGENTS_* field -> credential_malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=t\nVBCDX_AGENTS_FOO=bar\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  assert.equal(reasonOf(() => readCredentialFile(p)), 'credential_malformed');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: case-variant known field (VBCDX_AGENTS_Token) rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_Token=t\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  assert.equal(reasonOf(() => readCredentialFile(p)), 'credential_malformed');
  rmSync(dir, { recursive: true, force: true });
});

test('readCredentialFile: USER/PASSWORD present but ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=t\nVBCDX_AGENTS_USER=u\nVBCDX_AGENTS_PASSWORD=pw\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  const cred = readCredentialFile(p);
  assert.equal(cred.token, 't');
  rmSync(dir, { recursive: true, force: true });
});

test('credential errors never contain the token value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  chmodSync(dir, 0o700);
  const p = join(dir, 'x.env');
  writeFileSync(p, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_TOKEN=SUPERSECRETVALUE\nVBCDX_AGENTS_FOO=x\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  try {
    readCredentialFile(p);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes('SUPERSECRETVALUE'));
  }
  rmSync(dir, { recursive: true, force: true });
});
