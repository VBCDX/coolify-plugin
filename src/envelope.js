// Result envelope construction (§5).
//
// Every tool returns complete text plus a matching structuredContent object that
// conforms to the tool's declared outputSchema. Required fields: outcome, effect,
// request:{method,path,attempted}, verification. `data` appears only for
// ok/accepted; every other outcome carries reason + message. isError is derived
// from the outcome, never set independently — so "success reported for a failed
// call" (the sibling plugin's defect class) cannot happen by forgetting a flag.

import { ERROR_OUTCOMES, MAX_ENVELOPE_BYTES, REASONS, VERIFICATIONS } from './contract.js';
import { scrub } from './redact.js';

/**
 * A local, pre-network refusal. Thrown by gates and credential handling so the
 * call short-circuits before any file read or HTTP happens, and carries the
 * fixed reason code the envelope needs.
 */
export class RefusedError extends Error {
  /**
   * @param {string} reason one of REASONS
   * @param {string} message operator-facing, secret-free
   * @param {object} [evidence] optional redacted evidence
   */
  constructor(reason, message, evidence) {
    super(message);
    this.name = 'RefusedError';
    this.reason = reason;
    this.evidence = evidence;
  }
}

/** Build the request descriptor carried on every envelope. */
export function req(method, path, attempted) {
  return { method, path, attempted: !!attempted };
}

function assertReason(reason) {
  if (!REASONS.includes(reason)) throw new Error(`internal: unknown reason "${reason}"`);
}

function assertVerification(v) {
  if (!VERIFICATIONS.includes(v)) throw new Error(`internal: unknown verification "${v}"`);
}

/**
 * @typedef {Object} Envelope
 * @property {string} outcome
 * @property {string} effect
 * @property {{method:string,path:string,attempted:boolean}} request
 * @property {string} verification
 * @property {number} [http_status]
 * @property {*} [data]
 * @property {string} [reason]
 * @property {string} [message]
 * @property {*} [evidence]
 */

/** ok — read succeeded, or a synchronous configuration change was verified. */
export function ok(effect, request, data, verification = 'confirmed', http_status) {
  assertVerification(verification);
  const env = { outcome: 'ok', effect, request, verification, data };
  if (http_status != null) env.http_status = http_status;
  return env;
}

/** accepted — API acknowledged queued lifecycle work; not proof of completion. */
export function accepted(effect, request, data, verification = 'pending', http_status) {
  assertVerification(verification);
  const env = { outcome: 'accepted', effect, request, verification, data };
  if (http_status != null) env.http_status = http_status;
  return env;
}

function problem(outcome, effect, request, reason, message, { verification = 'not_applicable', http_status, evidence } = {}) {
  assertReason(reason);
  assertVerification(verification);
  const env = {
    outcome,
    effect,
    request,
    verification,
    reason,
    message: scrub(message),
  };
  if (http_status != null) env.http_status = http_status;
  if (evidence !== undefined) env.evidence = evidence;
  return env;
}

/** refused — local input/config/credential/gate failure before network. */
export function refused(effect, request, reason, message, opts) {
  return problem('refused', effect, request, reason, message, opts);
}

/** failed — read/preflight failed or API explicitly rejected the operation. */
export function failed(effect, request, reason, message, opts) {
  return problem('failed', effect, request, reason, message, opts);
}

/** unverified — valid acknowledgement but state could not be confirmed. */
export function unverified(effect, request, reason, message, opts) {
  return problem('unverified', effect, request, reason, message, opts);
}

/** indeterminate — mutation may have applied; a reliable answer is impossible. */
export function indeterminate(effect, request, reason, message, opts) {
  return problem('indeterminate', effect, request, reason, message, opts);
}

/**
 * Turn an envelope into an MCP tool result. isError is derived from the outcome.
 * The text is a deterministic rendering of the same envelope, so the human-
 * readable content and the structuredContent can never disagree.
 *
 * @param {Envelope} env
 * @returns {{content: Array<{type:string,text:string}>, structuredContent: Envelope, isError: boolean}}
 */
export function toMcpResult(env) {
  let structured = env;
  let text = renderText(env);
  // Enforce the 256 KiB envelope ceiling. If the data payload pushes us over,
  // drop `data` and report it truncated rather than emit an oversized frame.
  if (byteLength(JSON.stringify(structured)) > MAX_ENVELOPE_BYTES) {
    const trimmed = { ...env };
    delete trimmed.data;
    trimmed.evidence = { ...(trimmed.evidence || {}), truncated: true, note: 'result exceeded 256 KiB; data omitted' };
    if (!ERROR_OUTCOMES.includes(trimmed.outcome)) {
      // A read that cannot be delivered within the envelope budget is a failure,
      // not a silent empty success.
      structured = failed(env.effect, env.request, 'response_too_large',
        'Result exceeded the 256 KiB envelope limit.', { http_status: env.http_status });
    } else {
      structured = trimmed;
    }
    text = renderText(structured);
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: ERROR_OUTCOMES.includes(structured.outcome),
  };
}

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** Deterministic human rendering of an envelope. */
function renderText(env) {
  const lines = [];
  const attempted = env.request?.attempted ? 'attempted' : 'not attempted';
  lines.push(`outcome: ${env.outcome} (${env.effect})`);
  lines.push(`request: ${env.request?.method} ${env.request?.path} (${attempted})`);
  if (env.http_status != null) lines.push(`http_status: ${env.http_status}`);
  lines.push(`verification: ${env.verification}`);
  if (env.reason) lines.push(`reason: ${env.reason}`);
  if (env.message) lines.push(`message: ${scrub(env.message)}`);
  if (env.data !== undefined) {
    lines.push('data:');
    lines.push(scrub(JSON.stringify(env.data, null, 2)));
  }
  if (env.evidence !== undefined) {
    lines.push('evidence:');
    lines.push(scrub(JSON.stringify(env.evidence, null, 2)));
  }
  return lines.join('\n');
}
