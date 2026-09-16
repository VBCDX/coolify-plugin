// Input validation (§6).
//
// Each tool declares a JSON-Schema-shaped inputSchema that is the single source
// for both the manifest the model reads and this validator. Unknown inputs are
// rejected (additionalProperties:false); required fields, enums, ranges, lengths,
// and domain formats are enforced here. Semantic formats that JSON Schema cannot
// express (a single encoded path component, a public git URL) are checked by the
// format validators below so the manifest schema and the runtime never disagree.

import { RefusedError } from './envelope.js';

const MAX_ENV_VALUE_BYTES = 64 * 1024;

/** @type {Record<string, (v: any) => string|null>} */
const FORMATS = {
  'uuid-component'(v) {
    if (typeof v !== 'string' || v.length < 1 || v.length > 255) return 'must be 1–255 characters';
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(v)) return 'must not contain control characters';
    if (v.includes('/') || v.includes('\\')) return 'must not contain path separators';
    if (v === '.' || v === '..') return 'must not be a traversal component';
    if (/%2e|%2f/i.test(v)) return 'must not contain encoded traversal sequences';
    return null;
  },
  name(v) {
    if (typeof v !== 'string' || v.length > 255) return 'must be at most 255 characters';
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(v)) return 'must not contain control characters';
    return null;
  },
  description(v) {
    if (typeof v !== 'string' || v.length > 8192) return 'must be at most 8192 characters';
    if (v.includes('\0')) return 'must not contain a NUL byte';
    return null;
  },
  'env-key'(v) {
    if (typeof v !== 'string' || v.length < 1 || v.length > 255) return 'must be 1–255 characters';
    if (v.includes('\0')) return 'must not contain a NUL byte';
    if (/[\r\n]/.test(v)) return 'must not contain line breaks';
    return null;
  },
  'env-value'(v) {
    if (typeof v !== 'string') return 'must be a string';
    if (v.includes('\0')) return 'must not contain a NUL byte';
    if (Buffer.byteLength(v, 'utf8') > MAX_ENV_VALUE_BYTES) return 'must be at most 64 KiB';
    return null;
  },
  'git-http-url'(v) {
    if (typeof v !== 'string' || v === '') return 'must be a URL';
    let u;
    try {
      u = new URL(v);
    } catch {
      return 'must be a valid URL';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be an http(s) URL';
    if (u.username || u.password) return 'must not contain embedded credentials';
    return null;
  },
  domains(v) {
    if (typeof v !== 'string' || v === '') return 'must be a comma-separated domain string';
    const parts = v.split(',').map((s) => s.trim());
    for (const part of parts) {
      if (part === '') return 'must not contain empty entries';
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f\s]/.test(part)) return 'entries must not contain whitespace or control characters';
      const candidate = /^https?:\/\//i.test(part) ? part : `https://${part}`;
      let u;
      try {
        u = new URL(candidate);
      } catch {
        return `invalid domain: ${part}`;
      }
      if (u.username || u.password) return 'domains must not contain embedded credentials';
    }
    return null;
  },
  ports(v) {
    if (typeof v !== 'string' || v === '') return 'must be a comma-separated list of ports';
    const parts = v.split(',').map((s) => s.trim());
    for (const part of parts) {
      if (!/^[0-9]+$/.test(part)) return `invalid port: ${part}`;
      const n = Number(part);
      if (n < 1 || n > 65535) return `port out of range: ${part}`;
    }
    return null;
  },
  confirm(v) {
    if (typeof v !== 'string' || v === '') return 'confirmation string is required';
    return null;
  },
};

/**
 * Validate raw args against a tool inputSchema. Returns a cleaned object with
 * declared defaults applied.
 *
 * @param {object} schema
 * @param {Record<string, unknown>} rawArgs
 * @returns {Record<string, unknown>}
 * @throws {RefusedError} validation_failed
 */
export function validateArgs(schema, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const props = schema.properties || {};
  const out = {};

  // Reject unknown inputs.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) fail(`unknown input "${key}"`);
    }
  }

  // Required.
  for (const key of schema.required || []) {
    if (args[key] === undefined) fail(`missing required input "${key}"`);
  }

  // Per-field validation + defaults.
  for (const [key, fieldSchema] of Object.entries(props)) {
    let value = args[key];
    if (value === undefined) {
      if ('default' in fieldSchema) out[key] = fieldSchema.default;
      continue;
    }
    checkField(key, value, fieldSchema);
    out[key] = value;
  }

  // Exactly-one groups (e.g. environment_name/environment_uuid, uuid/tag).
  for (const group of schema.exactlyOne || []) {
    const present = group.filter((k) => out[k] !== undefined && out[k] !== null && out[k] !== '');
    if (present.length !== 1) {
      fail(`exactly one of ${group.map((k) => `"${k}"`).join(', ')} is required`);
    }
  }

  return out;
}

function checkField(key, value, fieldSchema) {
  const { type } = fieldSchema;
  if (type === 'string') {
    if (typeof value !== 'string') fail(`"${key}" must be a string`);
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(`"${key}" must be an integer`);
  } else if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) fail(`"${key}" must be a number`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') fail(`"${key}" must be a boolean`);
  }

  if (fieldSchema.const !== undefined && value !== fieldSchema.const) {
    fail(`"${key}" must be ${JSON.stringify(fieldSchema.const)}`);
  }
  if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
    fail(`"${key}" must be one of ${fieldSchema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (fieldSchema.minimum !== undefined && value < fieldSchema.minimum) fail(`"${key}" must be >= ${fieldSchema.minimum}`);
    if (fieldSchema.maximum !== undefined && value > fieldSchema.maximum) fail(`"${key}" must be <= ${fieldSchema.maximum}`);
  }
  if (typeof value === 'string') {
    if (fieldSchema.minLength !== undefined && value.length < fieldSchema.minLength) fail(`"${key}" is too short`);
    if (fieldSchema.maxLength !== undefined && value.length > fieldSchema.maxLength) fail(`"${key}" is too long`);
    if (fieldSchema.format) {
      const fmt = FORMATS[fieldSchema.format];
      if (fmt) {
        const err = fmt(value);
        if (err) fail(`"${key}" ${err}`);
      }
    }
  }
}

function fail(message) {
  throw new RefusedError('validation_failed', `Invalid input: ${message}.`);
}
