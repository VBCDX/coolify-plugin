// Write tools (§5, §6).
//
// Ordinary configuration writes (create_application, env create/update) are
// verified by read-back with the same credential snapshot; if read access is
// unavailable the result is unverified and says the write may have applied — it
// is never retried. Lifecycle writes (deploy, start) return accepted after a
// valid acknowledgement without a GET preflight, which permits deploy-only
// tokens; accepted is never treated as completion.

import { projectApplication } from '../projections.js';
import { BUILD_PACKS } from '../contract.js';
import {
  HttpError, accepted, failed, indeterminate, mapHttpStatus, mapTransportError,
  ok, req, unverified, uuidField,
} from './common.js';

const envValueField = { type: 'string', format: 'env-value', description: 'Value (may be empty; up to 64 KiB; multiline preserved).' };
const envKeyField = { type: 'string', format: 'env-key', description: 'Environment variable key.' };

/** POST helper: dispatch a mutation and hand the response to `onResponse`. */
async function post(client, { segments, query, body }, effect, request, onResponse) {
  try {
    const res = await client.request({ method: 'POST', segments, query, body });
    return onResponse(res);
  } catch (err) {
    if (err instanceof HttpError) return mapTransportError(err, effect, request, { mutation: true });
    throw err;
  }
}

const createApplication = {
  name: 'create_application',
  description: 'Create a public-repository application (instant_deploy is always false) and verify by read-back.',
  effect: 'write',
  permissions: ['write', 'read'],
  inputSchema: {
    type: 'object',
    required: ['project_uuid', 'server_uuid', 'git_repository', 'git_branch', 'build_pack'],
    additionalProperties: false,
    exactlyOne: [['environment_name', 'environment_uuid']],
    properties: {
      project_uuid: uuidField,
      server_uuid: uuidField,
      environment_name: { type: 'string', maxLength: 255, description: 'Target environment name (exactly one of name/uuid).' },
      environment_uuid: { type: 'string', format: 'uuid-component', description: 'Target environment UUID (exactly one of name/uuid).' },
      git_repository: { type: 'string', format: 'git-http-url', description: 'Public HTTP(S) git repository URL.' },
      git_branch: { type: 'string', maxLength: 255, description: 'Git branch.' },
      build_pack: { type: 'string', enum: [...BUILD_PACKS], description: 'Build pack.' },
      name: { type: 'string', format: 'name', description: 'Application name (optional).' },
      description: { type: 'string', format: 'description', description: 'Application description (optional).' },
      domains: { type: 'string', format: 'domains', description: 'Comma-separated HTTP(S) domains (optional).' },
      ports_exposes: { type: 'string', format: 'ports', description: 'Comma-separated exposed ports (optional).' },
      destination_uuid: { type: 'string', format: 'uuid-component', description: 'Destination UUID (optional).' },
    },
  },
  dataSchema: {
    type: 'object',
    additionalProperties: true,
    properties: { uuid: { type: 'string' }, application: { type: 'object' } },
  },
  route: () => ({ method: 'POST', segments: ['applications', 'public'] }),
  run: async ({ args, client }) => {
    const body = {
      project_uuid: args.project_uuid,
      server_uuid: args.server_uuid,
      git_repository: args.git_repository,
      git_branch: args.git_branch,
      build_pack: args.build_pack,
      instant_deploy: false, // always explicit
    };
    if (args.environment_name !== undefined) body.environment_name = args.environment_name;
    if (args.environment_uuid !== undefined) body.environment_uuid = args.environment_uuid;
    for (const k of ['name', 'description', 'domains', 'ports_exposes', 'destination_uuid']) {
      if (args[k] !== undefined) body[k] = args[k];
    }
    const request = req('POST', client.pathFor(['applications', 'public']), true);
    return post(client, { segments: ['applications', 'public'], body }, 'write', request, async (res) => {
      if (!res.ok) return mapHttpStatus(res, 'write', request);
      const newUuid = res.hasJson && res.json && typeof res.json.uuid === 'string' ? res.json.uuid : null;
      if (!newUuid) {
        return indeterminate('write', request, 'indeterminate_write',
          'The API returned 2xx without the documented application uuid; the create may have applied and was not retried.',
          { http_status: res.status });
      }
      // Read-back verification with the same credential snapshot.
      try {
        const check = await client.request({ method: 'GET', segments: ['applications', newUuid] });
        if (check.status === 401 || check.status === 403) {
          return unverified('write', request, 'data_unavailable',
            'The application was created but read access to verify it is unavailable; it was not retried.',
            { http_status: res.status, verification: 'unavailable', evidence: { uuid: newUuid } });
        }
        if (!check.ok || !check.hasJson || typeof check.json !== 'object') {
          return unverified('write', request, 'verification_failed',
            'The application was created but could not be read back to verify.',
            { http_status: res.status, verification: 'unavailable', evidence: { uuid: newUuid } });
        }
        const app = check.json;
        const mismatches = [];
        if (app.git_repository !== undefined && app.git_repository !== args.git_repository) mismatches.push('git_repository');
        if (app.git_branch !== undefined && app.git_branch !== args.git_branch) mismatches.push('git_branch');
        if (app.build_pack !== undefined && app.build_pack !== args.build_pack) mismatches.push('build_pack');
        if (args.name !== undefined && app.name !== undefined && app.name !== args.name) mismatches.push('name');
        if (mismatches.length) {
          return unverified('write', request, 'verification_failed',
            `The application was created but read-back differs on: ${mismatches.join(', ')}.`,
            { http_status: res.status, verification: 'mismatch', evidence: { uuid: newUuid, mismatched_fields: mismatches } });
        }
        return ok('write', request, { uuid: newUuid, application: projectApplication(app, { detail: true }) }, 'confirmed', res.status);
      } catch (err) {
        if (err instanceof HttpError) {
          return unverified('write', request, 'verification_failed',
            'The application was created but read-back verification failed; it was not retried.',
            { http_status: res.status, verification: 'unavailable', evidence: { uuid: newUuid } });
        }
        throw err;
      }
    });
  },
};

const deploy = {
  name: 'deploy',
  description: 'Trigger a deployment by uuid or tag. Returns accepted only; not proof of completion.',
  effect: 'write',
  permissions: ['deploy'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    exactlyOne: [['uuid', 'tag']],
    properties: {
      uuid: { type: 'string', format: 'uuid-component', description: 'Resource UUID (exactly one of uuid/tag).' },
      tag: { type: 'string', maxLength: 255, description: 'Tag name (exactly one of uuid/tag).' },
      force: { type: 'boolean', default: false, description: 'Force rebuild without cache (default false).' },
      docker_tag: { type: 'string', maxLength: 255, description: 'Docker image tag (optional).' },
    },
  },
  dataSchema: { type: 'object', additionalProperties: true, properties: { deployments: { type: 'array' } } },
  route: () => ({ method: 'POST', segments: ['deploy'] }),
  run: async ({ args, client }) => {
    const query = { force: args.force };
    if (args.uuid !== undefined) query.uuid = args.uuid;
    if (args.tag !== undefined) query.tag = args.tag;
    if (args.docker_tag !== undefined) query.docker_tag = args.docker_tag;
    const request = req('POST', client.pathFor(['deploy'], query), true);
    return post(client, { segments: ['deploy'], query }, 'write', request, (res) => {
      if (!res.ok) return mapHttpStatus(res, 'write', request);
      const deployments = res.hasJson && res.json && Array.isArray(res.json.deployments) ? res.json.deployments : null;
      if (!deployments || deployments.length === 0) {
        return indeterminate('write', request, 'indeterminate_write',
          'The API returned 2xx without the documented deployments list; nothing may have matched and it was not retried.',
          { http_status: res.status });
      }
      const projected = deployments.map((d) => ({
        resource_uuid: d.resource_uuid,
        deployment_uuid: d.deployment_uuid,
        ...(d.message !== undefined ? { message: d.message } : {}),
      }));
      return accepted('write', request, { deployments: projected }, 'pending', res.status);
    });
  },
};

const startApplication = {
  name: 'start_application',
  description: 'Start an application. Returns accepted; not proof of serving.',
  effect: 'write',
  permissions: ['deploy'],
  inputSchema: {
    type: 'object',
    required: ['uuid'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      force: { type: 'boolean', default: false, description: 'Force rebuild (default false).' },
      instant_deploy: { type: 'boolean', default: false, description: 'Instant deploy (default false).' },
    },
  },
  dataSchema: { type: 'object', additionalProperties: true, properties: { deployment_uuid: { type: 'string' }, message: { type: 'string' } } },
  route: (args) => ({ method: 'POST', segments: ['applications', args && args.uuid, 'start'] }),
  run: async ({ args, client }) => {
    const query = { force: args.force, instant_deploy: args.instant_deploy };
    const request = req('POST', client.pathFor(['applications', args.uuid, 'start'], query), true);
    return post(client, { segments: ['applications', args.uuid, 'start'], query }, 'write', request, (res) => {
      if (!res.ok) return mapHttpStatus(res, 'write', request);
      if (!res.hasJson || typeof res.json !== 'object' || res.json === null) {
        return indeterminate('write', request, 'indeterminate_write',
          'The API returned 2xx without the documented body; the start may have queued and was not retried.', { http_status: res.status });
      }
      const data = {};
      if (typeof res.json.deployment_uuid === 'string') data.deployment_uuid = res.json.deployment_uuid;
      if (res.json.message !== undefined) data.message = res.json.message;
      return accepted('write', request, data, 'pending', res.status);
    });
  },
};

function envMutationTool({ name, description, method }) {
  return {
    name,
    description,
    effect: 'write',
    permissions: ['write', 'read', 'read:sensitive'],
    inputSchema: {
      type: 'object',
      required: ['uuid', 'key', 'value', 'is_preview'],
      additionalProperties: false,
      properties: {
        uuid: uuidField,
        key: envKeyField,
        value: envValueField,
        is_preview: { type: 'boolean', description: 'Whether the variable applies to preview deployments.' },
        is_literal: { type: 'boolean', description: 'Treat the value as a literal (optional).' },
        is_multiline: { type: 'boolean', description: 'Multiline value (optional).' },
        is_shown_once: { type: 'boolean', description: 'Shown once in the UI (optional).' },
      },
    },
    dataSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        uuid: { type: 'string' }, key: { type: 'string' }, is_preview: { type: 'boolean' },
        verified: { const: true }, affected_contexts: { type: 'array' },
      },
    },
    route: (args) => ({ method, segments: ['applications', args && args.uuid, 'envs'] }),
    run: async ({ args, client }) => {
      const body = { key: args.key, value: args.value, is_preview: args.is_preview };
      for (const k of ['is_literal', 'is_multiline', 'is_shown_once']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const request = req(method, client.pathFor(['applications', args.uuid, 'envs']), true);
      try {
        const res = await client.request({ method, segments: ['applications', args.uuid, 'envs'], body });
        if (!res.ok) return mapHttpStatus(res, 'write', request);
        return verifyEnvWriteback(client, args, request, res.status);
      } catch (err) {
        if (err instanceof HttpError) return mapTransportError(err, 'write', request, { mutation: true });
        throw err;
      }
    },
  };
}

/**
 * Read back the application's envs with the same credential and confirm the
 * mutation by identity, context, and value. Never echoes a secret value.
 */
async function verifyEnvWriteback(client, args, request, writeStatus) {
  let check;
  try {
    check = await client.request({ method: 'GET', segments: ['applications', args.uuid, 'envs'] });
  } catch (err) {
    if (err instanceof HttpError) {
      return unverified('write', request, 'verification_failed',
        'The env write was acknowledged but read-back failed; it was not retried.',
        { http_status: writeStatus, verification: 'unavailable', evidence: { key: args.key, is_preview: args.is_preview } });
    }
    throw err;
  }
  if (check.status === 401 || check.status === 403) {
    return unverified('write', request, 'data_unavailable',
      'The env write was acknowledged but read access to verify it is unavailable; it was not retried.',
      { http_status: writeStatus, verification: 'unavailable', evidence: { key: args.key, is_preview: args.is_preview } });
  }
  if (!check.ok || !Array.isArray(check.json)) {
    return unverified('write', request, 'verification_failed',
      'The env write was acknowledged but the env list could not be read back to verify.',
      { http_status: writeStatus, verification: 'unavailable', evidence: { key: args.key, is_preview: args.is_preview } });
  }
  const sameKey = check.json.filter((e) => e && e.key === args.key);
  const affectedContexts = sameKey.map((e) => ({ is_preview: !!e.is_preview }));
  const match = sameKey.find((e) => !!e.is_preview === !!args.is_preview);
  if (!match) {
    return unverified('write', request, 'verification_failed',
      'The env write was acknowledged but the key/context was not visible on read-back.',
      { http_status: writeStatus, verification: 'unavailable', evidence: { key: args.key, is_preview: args.is_preview, affected_contexts: affectedContexts } });
  }
  const envUuid = typeof match.uuid === 'string' ? match.uuid : undefined;
  // Value comparison: a masked/shown-once value cannot verify an exact value.
  if (typeof match.value === 'string') {
    if (match.value === args.value) {
      const data = { uuid: envUuid, key: args.key, is_preview: !!args.is_preview, verified: true };
      if (affectedContexts.length > 1) data.affected_contexts = affectedContexts;
      return ok('write', request, data, 'confirmed', writeStatus);
    }
    return unverified('write', request, 'verification_failed',
      'The env write was acknowledged but the read-back value does not match the submitted value.',
      { http_status: writeStatus, verification: 'mismatch', evidence: { key: args.key, is_preview: args.is_preview } });
  }
  // Key and context confirmed, but the value is masked/absent, so the exact value
  // could not be verified.
  return unverified('write', request, 'verification_failed',
    'The env write was acknowledged and the key/context matched, but the stored value is masked and could not be verified.',
    { http_status: writeStatus, verification: 'unavailable', evidence: { key: args.key, is_preview: args.is_preview, affected_contexts: affectedContexts } });
}

const createApplicationEnv = envMutationTool({
  name: 'create_application_env',
  description: 'Create an application environment variable and verify by read-back. Never echoes the value.',
  method: 'POST',
});
const updateApplicationEnv = envMutationTool({
  name: 'update_application_env',
  description: 'Update an application environment variable and verify by read-back. Never echoes the value.',
  method: 'PATCH',
});

export const writeTools = [
  createApplication, deploy, startApplication, createApplicationEnv, updateApplicationEnv,
];
