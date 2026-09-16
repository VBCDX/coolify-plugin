// Fixed contract vocabulary for vbcdx.coolify/1.
//
// These enums are the spec's, verbatim. They are the single source the manifest,
// the output schemas, and the runtime all read from, so a new outcome or reason
// cannot exist in one place and not another.

export const CONTRACT = 'vbcdx.coolify/1';
export const SERVICE = 'coolify';
export const SCHEMA_VERSION = 1;

/** Effect metadata every tool declares. */
export const EFFECTS = Object.freeze(['read', 'write', 'destructive']);

/**
 * Coolify token permissions (§4). Descriptive only — the server never infers
 * permission from these; the token and the service decide. We record what a tool
 * needs so an operator can provision an appropriately scoped token.
 */
export const PERMISSIONS = Object.freeze([
  'read',
  'read:sensitive',
  'write',
  'deploy',
  'root',
  'public',
]);

/** Result outcomes (§5). */
export const OUTCOMES = Object.freeze([
  'ok',
  'accepted',
  'refused',
  'failed',
  'unverified',
  'indeterminate',
]);

/** Outcomes that set MCP isError:true. */
export const ERROR_OUTCOMES = Object.freeze(['refused', 'failed', 'unverified', 'indeterminate']);

/** Verification states (§5). */
export const VERIFICATIONS = Object.freeze([
  'not_applicable',
  'confirmed',
  'pending',
  'unavailable',
  'mismatch',
]);

/** Fixed reason codes (§4, §5). */
export const REASONS = Object.freeze([
  // credential/local
  'credential_not_absolute',
  'credential_missing',
  'credential_unreadable',
  'credential_unsafe',
  'credential_malformed',
  'credential_key_missing',
  'credential_rejected',
  'permission_denied',
  'validation_failed',
  'server_not_configured',
  'write_gate_disabled',
  'confirmation_required',
  'confirmation_mismatch',
  // upstream/network
  'not_found',
  'conflict',
  'rate_limited',
  'upstream_error',
  'network_error',
  'timeout',
  'response_too_large',
  'unexpected_response',
  'verification_failed',
  'data_unavailable',
  'indeterminate_write',
  'unsupported_operation',
]);

/** Envelope byte ceiling (§3): tool envelopes limited to 256 KiB. */
export const MAX_ENVELOPE_BYTES = 256 * 1024;

/** Upstream body ceiling (§3): 2 MiB before parsing. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Text/log excerpt ceiling (§3): 64 KiB with explicit truncation. */
export const MAX_TEXT_BYTES = 64 * 1024;

/** `build_pack` enum (§6). */
export const BUILD_PACKS = Object.freeze([
  'nixpacks',
  'railpack',
  'static',
  'dockerfile',
  'dockercompose',
]);
