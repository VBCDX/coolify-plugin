import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../src/validate.js';
import { RefusedError } from '../src/envelope.js';

const schema = {
  type: 'object',
  required: ['uuid'],
  additionalProperties: false,
  properties: {
    uuid: { type: 'string', format: 'uuid-component' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    build_pack: { type: 'string', enum: ['nixpacks', 'dockerfile'] },
    git_repository: { type: 'string', format: 'git-http-url' },
  },
};

test('applies defaults', () => {
  const out = validateArgs(schema, { uuid: 'abc' });
  assert.equal(out.limit, 25);
});

test('rejects unknown input', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'abc', surprise: 1 }), RefusedError);
});

test('rejects missing required', () => {
  assert.throws(() => validateArgs(schema, {}), /required/);
});

test('rejects out-of-range integer', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'a', limit: 500 }), /<= 100/);
});

test('rejects bad enum', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'a', build_pack: 'cargo' }), /one of/);
});

test('uuid with slash rejected (traversal/separator)', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'a/b' }), /separators/);
});

test('uuid ".." rejected', () => {
  assert.throws(() => validateArgs(schema, { uuid: '..' }), /traversal/);
});

test('git url with userinfo rejected', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'a', git_repository: 'https://u:p@github.com/x/y' }), /credentials/);
});

test('git url non-http rejected', () => {
  assert.throws(() => validateArgs(schema, { uuid: 'a', git_repository: 'git@github.com:x/y' }), /valid URL|http/);
});

test('exactlyOne enforced', () => {
  const s = {
    type: 'object',
    additionalProperties: false,
    exactlyOne: [['uuid', 'tag']],
    properties: { uuid: { type: 'string' }, tag: { type: 'string' } },
  };
  assert.throws(() => validateArgs(s, {}), /exactly one/);
  assert.throws(() => validateArgs(s, { uuid: 'a', tag: 'b' }), /exactly one/);
  assert.deepEqual(validateArgs(s, { uuid: 'a' }), { uuid: 'a' });
});

test('env-value allows empty and multiline, rejects NUL and oversize', () => {
  const s = { type: 'object', additionalProperties: false, properties: { value: { type: 'string', format: 'env-value' } } };
  assert.deepEqual(validateArgs(s, { value: '' }), { value: '' });
  assert.deepEqual(validateArgs(s, { value: 'a\nb' }), { value: 'a\nb' });
  assert.throws(() => validateArgs(s, { value: 'a\0b' }), /NUL/);
  assert.throws(() => validateArgs(s, { value: 'x'.repeat(64 * 1024 + 1) }), /64 KiB/);
});

test('const enforced (include_sensitive must be true)', () => {
  const s = { type: 'object', additionalProperties: false, properties: { include_sensitive: { const: true } } };
  assert.throws(() => validateArgs(s, { include_sensitive: false }), /must be true/);
  assert.deepEqual(validateArgs(s, { include_sensitive: true }), { include_sensitive: true });
});
