// Shared building blocks for tool definitions.
//
// The honest-results rules (§5) live here so every tool applies them the same
// way: HTTP status is checked before body shape; a 2xx alone is never treated as
// completion; a missing documented identifier is indeterminate, not a safe
// retry; reads never turn an error into an empty list.

import {
  EFFECTS, ERROR_OUTCOMES, OUTCOMES, PERMISSIONS, REASONS, VERIFICATIONS,
} from '../contract.js';
import {
  accepted, failed, indeterminate, ok, refused, req, unverified,
} from '../envelope.js';
import { HttpError } from '../http.js';

/** JSON Schema for the envelope every tool returns as structuredContent. */
export function envelopeSchema(dataSchema = {}) {
  return {
    type: 'object',
    required: ['outcome', 'effect', 'request', 'verification'],
    additionalProperties: false,
    properties: {
      outcome: { type: 'string', enum: [...OUTCOMES] },
      effect: { type: 'string', enum: [...EFFECTS] },
      request: {
        type: 'object',
        required: ['method', 'path', 'attempted'],
        additionalProperties: false,
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          attempted: { type: 'boolean' },
        },
      },
      verification: { type: 'string', enum: [...VERIFICATIONS] },
      http_status: { type: 'integer' },
      reason: { type: 'string', enum: [...REASONS] },
      message: { type: 'string' },
      data: dataSchema,
      evidence: {},
    },
  };
}

/** The data schema shared by every list tool. */
export const listDataSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    items: { type: 'array' },
    count: { type: 'integer' },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    next_offset: { type: ['integer', 'null'] },
    truncated: { type: 'boolean' },
  },
};

/** Reusable input field fragments. */
export const uuidField = { type: 'string', format: 'uuid-component', description: 'Resource UUID (one path component).' };
export const offsetField = { type: 'integer', minimum: 0, default: 0, description: 'Local window offset (default 0).' };
export const limitField = { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Local window size 1–100 (default 25).' };

/**
 * Apply a local offset/limit window over a fully-read upstream array (§6).
 *
 * @param {any[]} array
 * @param {number} offset
 * @param {number} limit
 * @param {(x:any)=>any} projectFn
 */
export function windowList(array, offset, limit, projectFn) {
  const total = array.length;
  const slice = array.slice(offset, offset + limit).map(projectFn);
  const count = slice.length;
  const nextOffset = offset + count < total ? offset + count : null;
  return {
    items: slice,
    count,
    offset,
    limit,
    total,
    next_offset: nextOffset,
    truncated: nextOffset !== null,
  };
}

/**
 * Map an HttpError (transport failure) to a failed/indeterminate envelope.
 *
 * @param {HttpError} err
 * @param {string} effect
 * @param {{method:string,path:string,attempted:boolean}} request
 * @param {{mutation?: boolean}} [opts] when true, ambiguous transport failures
 *        after dispatch are indeterminate (the mutation may have applied).
 */
export function mapTransportError(err, effect, request, opts = {}) {
  const mutation = !!opts.mutation;
  switch (err.kind) {
    case 'timeout':
      return mutation
        ? indeterminate(effect, request, 'timeout', 'The call timed out after the mutation was dispatched; its effect is unknown. It was not retried.')
        : failed(effect, request, 'timeout', 'The call exceeded its time budget.');
    case 'cancelled':
      return mutation
        ? indeterminate(effect, request, 'indeterminate_write', 'The call was cancelled after the mutation was dispatched; its effect is unknown.')
        : failed(effect, request, 'network_error', 'The call was cancelled.');
    case 'network':
      return mutation
        ? indeterminate(effect, request, 'network_error', 'The connection failed after the mutation was dispatched; its effect is unknown. It was not retried.')
        : failed(effect, request, 'network_error', err.message);
    case 'redirect':
      return failed(effect, request, 'unexpected_response', err.message);
    case 'too_large':
      return failed(effect, request, 'response_too_large', err.message, { http_status: err.status });
    case 'bad_json':
      return mutation
        ? indeterminate(effect, request, 'indeterminate_write', 'The instance returned a malformed 2xx body after the mutation; its effect could not be confirmed.', { http_status: err.status })
        : failed(effect, request, 'unexpected_response', err.message, { http_status: err.status });
    default:
      return failed(effect, request, 'upstream_error', 'The upstream request failed.', { http_status: err.status });
  }
}

/**
 * Map a non-2xx HTTP status to a failed envelope, preserving safe status and
 * Retry-After. HTTP status is the first check (§5): a body claiming success at a
 * failure status is still a failure.
 *
 * @param {{status:number, retryAfter:string|null}} res
 * @param {string} effect
 * @param {{method:string,path:string,attempted:boolean}} request
 */
export function mapHttpStatus(res, effect, request) {
  const status = res.status;
  const evidence = res.retryAfter ? { retry_after: res.retryAfter } : undefined;
  if (status === 401) {
    return failed(effect, request, 'credential_rejected',
      'The Coolify API rejected the token (401). Check the token value.', { http_status: status, evidence });
  }
  if (status === 403) {
    return failed(effect, request, 'permission_denied',
      'The token is not permitted to perform this operation (403). Team access, owner role, API enablement, IP allowlists and token scope all matter; the server does not retry with another identity.',
      { http_status: status, evidence });
  }
  if (status === 404) {
    return failed(effect, request, 'not_found', 'The requested resource was not found (404).', { http_status: status, evidence });
  }
  if (status === 409) {
    return failed(effect, request, 'conflict', 'The operation conflicted with the current state (409).', { http_status: status, evidence });
  }
  if (status === 429) {
    return failed(effect, request, 'rate_limited', 'The API rate-limited the request (429).', { http_status: status, evidence });
  }
  if (status >= 500) {
    return failed(effect, request, 'upstream_error', `The instance returned a server error (${status}).`, { http_status: status, evidence });
  }
  return failed(effect, request, 'upstream_error', `The API rejected the request (${status}).`, { http_status: status, evidence });
}

// Re-export the envelope builders and req for tool modules.
export { accepted, failed, indeterminate, ok, refused, req, unverified, HttpError, ERROR_OUTCOMES, PERMISSIONS };
