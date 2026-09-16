// Bounded projections (§6).
//
// Read tools never return raw settings, Compose, or secrets. Each projection
// copies only the listed fields, omitting optional ones when absent. Env values
// are returned only on explicit opt-in and only when actually present and
// unredacted; a masked value is reported as redacted, never substituted.

/**
 * Copy only the named keys whose value is present (not null/undefined).
 * Booleans (including false) and empty strings are preserved.
 */
function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const APPLICATION_SUMMARY = [
  'uuid', 'name', 'fqdn', 'status', 'git_repository', 'git_branch',
  'git_commit_sha', 'build_pack', 'environment_id', 'updated_at',
];
const APPLICATION_DETAIL_EXTRA = [
  'docker_compose_location', 'health_check_path', 'ports_exposes', 'limits_memory', 'limits_cpus',
];

/** @param {any} a @param {{detail?: boolean}} [opts] */
export function projectApplication(a, opts = {}) {
  const keys = opts.detail ? [...APPLICATION_SUMMARY, ...APPLICATION_DETAIL_EXTRA] : APPLICATION_SUMMARY;
  return pick(a, keys);
}

/**
 * @param {any} r
 * @param {'application'|'database'|'service'} type
 */
export function projectResource(r, type) {
  const out = pick(r, ['uuid', 'name', 'status']);
  out.type = type;
  return out;
}

/** @param {any} s */
export function projectServer(s) {
  return pick(s, ['uuid', 'name', 'description', 'ip', 'port', 'proxy_type', 'unreachable_count']);
}

/** @param {any} p */
export function projectProject(p) {
  return pick(p, ['uuid', 'name', 'description']);
}

const DEPLOYMENT_KEYS = [
  'deployment_uuid', 'application_id', 'application_name', 'status', 'commit',
  'commit_message', 'created_at', 'updated_at', 'server_name', 'deployment_url',
  'is_api', 'restart_only', 'rollback',
];

/** @param {any} d */
export function projectDeployment(d) {
  return pick(d, DEPLOYMENT_KEYS);
}

const ENV_METADATA_KEYS = [
  'uuid', 'key', 'is_preview', 'is_literal', 'is_multiline', 'is_shown_once',
  'is_buildtime', 'is_runtime', 'comment',
];

/**
 * Project an environment variable. `value` is included only when
 * includeValues is true and the value is actually present and unredacted;
 * value_state always describes what happened.
 *
 * @param {any} e
 * @param {{includeValues?: boolean}} [opts]
 */
export function projectEnv(e, opts = {}) {
  const out = pick(e, ENV_METADATA_KEYS);
  if (!opts.includeValues) {
    out.value_state = 'not_requested';
    return out;
  }
  // Requested. Preserve an actual empty string; distinguish a masked/redacted
  // value from a genuinely absent one.
  const v = e ? e.value : undefined;
  if (typeof v === 'string') {
    out.value = v;
    out.value_state = 'available';
  } else if (e && e.is_shown_once) {
    // A shown-once variable whose value is no longer returned is redacted by the
    // API, not absent.
    out.value_state = 'redacted';
  } else {
    out.value_state = 'absent';
  }
  return out;
}
