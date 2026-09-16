// Destructive tools (§5). These can interrupt service or discard work/data, so
// they require VBCDX_COOLIFY_WRITES=full and an exact confirmation string that
// binds the normalized target and options. The confirmation is an accident
// interlock — it is never sent upstream and is not proof of human approval.
//
// Deletes preflight the exact target, send every cleanup flag explicitly (never
// inheriting Coolify's true defaults), and verify by the exact UUID so a
// same-key preview variable cannot cause a false result.

import {
  HttpError, accepted, failed, indeterminate, mapHttpStatus, mapTransportError,
  ok, req, unverified, uuidField,
} from './common.js';

const confirmField = { type: 'string', format: 'confirm', description: 'Exact confirmation string binding the target and options.' };

async function post(client, { segments, query }, request, onResponse) {
  try {
    const res = await client.request({ method: 'POST', segments, query });
    return onResponse(res);
  } catch (err) {
    if (err instanceof HttpError) return mapTransportError(err, 'destructive', request, { mutation: true });
    throw err;
  }
}

const restartApplication = {
  name: 'restart_application',
  description: 'Restart an application (interrupts service). Returns accepted.',
  effect: 'destructive',
  permissions: ['deploy'],
  confirmString: (a) => `restart application ${a.uuid}`,
  inputSchema: {
    type: 'object',
    required: ['uuid', 'confirm'],
    additionalProperties: false,
    properties: { uuid: uuidField, confirm: confirmField },
  },
  dataSchema: { type: 'object', additionalProperties: true, properties: { deployment_uuid: { type: 'string' }, message: { type: 'string' } } },
  route: (args) => ({ method: 'POST', segments: ['applications', args && args.uuid, 'restart'] }),
  run: ({ args, client }) => {
    const request = req('POST', client.pathFor(['applications', args.uuid, 'restart']), true);
    return post(client, { segments: ['applications', args.uuid, 'restart'] }, request, (res) => {
      if (!res.ok) return mapHttpStatus(res, 'destructive', request);
      if (!res.hasJson || typeof res.json !== 'object' || res.json === null) {
        return indeterminate('destructive', request, 'indeterminate_write',
          'The API returned 2xx without a documented body; the restart may have queued and was not retried.', { http_status: res.status });
      }
      const data = {};
      if (typeof res.json.deployment_uuid === 'string') data.deployment_uuid = res.json.deployment_uuid;
      if (res.json.message !== undefined) data.message = res.json.message;
      return accepted('destructive', request, data, 'pending', res.status);
    });
  },
};

const cancelDeployment = {
  name: 'cancel_deployment',
  description: 'Cancel a running deployment (discards in-flight work). Returns accepted; status verbatim.',
  effect: 'destructive',
  permissions: ['deploy'],
  confirmString: (a) => `cancel deployment ${a.uuid}`,
  inputSchema: {
    type: 'object',
    required: ['uuid', 'confirm'],
    additionalProperties: false,
    properties: { uuid: uuidField, confirm: confirmField },
  },
  dataSchema: { type: 'object', additionalProperties: true, properties: { deployment_uuid: { type: 'string' }, status: { type: 'string' }, message: { type: 'string' } } },
  route: (args) => ({ method: 'POST', segments: ['deployments', args && args.uuid, 'cancel'] }),
  run: ({ args, client }) => {
    const request = req('POST', client.pathFor(['deployments', args.uuid, 'cancel']), true);
    return post(client, { segments: ['deployments', args.uuid, 'cancel'] }, request, (res) => {
      if (!res.ok) return mapHttpStatus(res, 'destructive', request);
      if (!res.hasJson || typeof res.json !== 'object' || res.json === null) {
        return indeterminate('destructive', request, 'indeterminate_write',
          'The API returned 2xx without a documented body; the cancel may have applied and was not retried.', { http_status: res.status });
      }
      const data = {};
      if (typeof res.json.deployment_uuid === 'string') data.deployment_uuid = res.json.deployment_uuid;
      if (res.json.status !== undefined) data.status = res.json.status; // verbatim
      if (res.json.message !== undefined) data.message = res.json.message;
      return accepted('destructive', request, data, 'pending', res.status);
    });
  },
};

const stopApplication = {
  name: 'stop_application',
  description: 'Stop an application (interrupts service). Returns accepted. docker_cleanup is sent explicitly.',
  effect: 'destructive',
  permissions: ['deploy'],
  confirmString: (a) => `stop application ${a.uuid} docker_cleanup=${a.docker_cleanup}`,
  inputSchema: {
    type: 'object',
    required: ['uuid', 'confirm'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      confirm: confirmField,
      docker_cleanup: { type: 'boolean', default: false, description: 'Prune docker resources on stop (default false; sent explicitly).' },
    },
  },
  dataSchema: { type: 'object', additionalProperties: true, properties: { uuid: { type: 'string' }, message: { type: 'string' } } },
  route: (args) => ({ method: 'POST', segments: ['applications', args && args.uuid, 'stop'] }),
  run: ({ args, client }) => {
    const query = { docker_cleanup: args.docker_cleanup };
    const request = req('POST', client.pathFor(['applications', args.uuid, 'stop'], query), true);
    return post(client, { segments: ['applications', args.uuid, 'stop'], query }, request, (res) => {
      if (!res.ok) return mapHttpStatus(res, 'destructive', request);
      const data = { uuid: args.uuid };
      if (res.hasJson && res.json && res.json.message !== undefined) data.message = res.json.message;
      return accepted('destructive', request, data, 'pending', res.status);
    });
  },
};

const deleteApplicationEnv = {
  name: 'delete_application_env',
  description: 'Delete a specific application environment variable by UUID, verifying that exact UUID is gone.',
  effect: 'destructive',
  permissions: ['write', 'read'],
  confirmString: (a) => `delete env ${a.env_uuid} of application ${a.uuid}`,
  inputSchema: {
    type: 'object',
    required: ['uuid', 'env_uuid', 'confirm'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      env_uuid: { type: 'string', format: 'uuid-component', description: 'The environment variable UUID to delete.' },
      confirm: confirmField,
    },
  },
  dataSchema: { type: 'object', additionalProperties: false, properties: { uuid: { type: 'string' }, env_uuid: { type: 'string' }, deleted: { const: true } } },
  route: (args) => ({ method: 'DELETE', segments: ['applications', args && args.uuid, 'envs', args && args.env_uuid] }),
  run: async ({ args, client }) => {
    const request = req('DELETE', client.pathFor(['applications', args.uuid, 'envs', args.env_uuid]), true);
    // Preflight: the exact env UUID must exist. A 404/absence before mutation is
    // not a successful deletion.
    let list;
    try {
      list = await client.request({ method: 'GET', segments: ['applications', args.uuid, 'envs'] });
    } catch (err) {
      if (err instanceof HttpError) return mapTransportError(err, 'destructive', req('GET', client.pathFor(['applications', args.uuid, 'envs']), true));
      throw err;
    }
    if (!list.ok) return mapHttpStatus(list, 'destructive', req('GET', client.pathFor(['applications', args.uuid, 'envs']), true));
    if (!Array.isArray(list.json)) {
      return failed('destructive', request, 'unexpected_response', 'The env list did not return the documented array shape.', { http_status: list.status });
    }
    const target = list.json.find((e) => e && e.uuid === args.env_uuid);
    if (!target) {
      return failed('destructive', request, 'not_found', 'No environment variable with that UUID exists on this application; nothing was deleted.', { evidence: { env_uuid: args.env_uuid } });
    }
    // Delete the exact UUID.
    let del;
    try {
      del = await client.request({ method: 'DELETE', segments: ['applications', args.uuid, 'envs', args.env_uuid] });
    } catch (err) {
      if (err instanceof HttpError) return mapTransportError(err, 'destructive', request, { mutation: true });
      throw err;
    }
    if (!del.ok) return mapHttpStatus(del, 'destructive', request);
    // Verify absence of that exact UUID (a same-key preview var remaining is fine).
    try {
      const after = await client.request({ method: 'GET', segments: ['applications', args.uuid, 'envs'] });
      if (after.status === 401 || after.status === 403) {
        return unverified('destructive', request, 'data_unavailable', 'The delete was acknowledged but read access to verify it is unavailable.', { http_status: del.status, verification: 'unavailable', evidence: { env_uuid: args.env_uuid } });
      }
      if (!after.ok || !Array.isArray(after.json)) {
        return unverified('destructive', request, 'verification_failed', 'The delete was acknowledged but the env list could not be read back to verify.', { http_status: del.status, verification: 'unavailable', evidence: { env_uuid: args.env_uuid } });
      }
      const stillThere = after.json.some((e) => e && e.uuid === args.env_uuid);
      if (stillThere) {
        return unverified('destructive', request, 'verification_failed', 'The delete was acknowledged but the exact UUID is still present on read-back.', { http_status: del.status, verification: 'mismatch', evidence: { env_uuid: args.env_uuid } });
      }
      return ok('destructive', request, { uuid: args.uuid, env_uuid: args.env_uuid, deleted: true }, 'confirmed', del.status);
    } catch (err) {
      if (err instanceof HttpError) return unverified('destructive', request, 'verification_failed', 'The delete was acknowledged but read-back verification failed.', { http_status: del.status, verification: 'unavailable', evidence: { env_uuid: args.env_uuid } });
      throw err;
    }
  },
};

const deleteApplication = {
  name: 'delete_application',
  description: 'Delete an application. All cleanup flags are sent explicitly; verifies disappearance or reports pending.',
  effect: 'destructive',
  permissions: ['write', 'read'],
  confirmString: (a) =>
    `delete application ${a.uuid} delete_configurations=${a.delete_configurations} delete_volumes=${a.delete_volumes} delete_connected_networks=${a.delete_connected_networks} docker_cleanup=${a.docker_cleanup}`,
  inputSchema: {
    type: 'object',
    required: ['uuid', 'confirm'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      confirm: confirmField,
      delete_configurations: { type: 'boolean', default: false, description: 'Delete configurations (default false; sent explicitly).' },
      delete_volumes: { type: 'boolean', default: false, description: 'Delete volumes (default false; sent explicitly).' },
      delete_connected_networks: { type: 'boolean', default: false, description: 'Delete connected networks (default false; sent explicitly).' },
      docker_cleanup: { type: 'boolean', default: false, description: 'Run docker cleanup (default false; sent explicitly).' },
    },
  },
  dataSchema: { type: 'object', additionalProperties: false, properties: { uuid: { type: 'string' }, deleted: { const: true } } },
  route: (args) => ({ method: 'DELETE', segments: ['applications', args && args.uuid] }),
  run: async ({ args, client }) => {
    const query = {
      delete_configurations: args.delete_configurations,
      delete_volumes: args.delete_volumes,
      delete_connected_networks: args.delete_connected_networks,
      docker_cleanup: args.docker_cleanup,
    };
    const request = req('DELETE', client.pathFor(['applications', args.uuid], query), true);
    // Preflight: the exact application must exist with read access.
    let pre;
    try {
      pre = await client.request({ method: 'GET', segments: ['applications', args.uuid] });
    } catch (err) {
      if (err instanceof HttpError) return mapTransportError(err, 'destructive', req('GET', client.pathFor(['applications', args.uuid]), true));
      throw err;
    }
    if (pre.status === 404) {
      return failed('destructive', request, 'not_found', 'No application with that UUID exists; nothing was deleted.', { http_status: 404, evidence: { uuid: args.uuid } });
    }
    if (!pre.ok) return mapHttpStatus(pre, 'destructive', req('GET', client.pathFor(['applications', args.uuid]), true));
    // Delete with all flags explicit.
    let del;
    try {
      del = await client.request({ method: 'DELETE', segments: ['applications', args.uuid], query });
    } catch (err) {
      if (err instanceof HttpError) return mapTransportError(err, 'destructive', request, { mutation: true });
      throw err;
    }
    if (!del.ok) return mapHttpStatus(del, 'destructive', request);
    // Verify disappearance under the same identity.
    try {
      const after = await client.request({ method: 'GET', segments: ['applications', args.uuid] });
      if (after.status === 404) {
        return ok('destructive', request, { uuid: args.uuid, deleted: true }, 'confirmed', del.status);
      }
      if (after.status === 401 || after.status === 403) {
        return unverified('destructive', request, 'data_unavailable', 'The delete was acknowledged but read access to verify disappearance is unavailable.', { http_status: del.status, verification: 'unavailable', evidence: { uuid: args.uuid } });
      }
      if (after.ok) {
        // The row is still visible: deletion may still be queued. Do not claim
        // volumes vanished.
        return accepted('destructive', request, { uuid: args.uuid }, 'pending', del.status);
      }
      return unverified('destructive', request, 'verification_failed', 'The delete was acknowledged but disappearance could not be confirmed.', { http_status: del.status, verification: 'unavailable', evidence: { uuid: args.uuid } });
    } catch (err) {
      if (err instanceof HttpError) return unverified('destructive', request, 'verification_failed', 'The delete was acknowledged but read-back verification failed.', { http_status: del.status, verification: 'unavailable', evidence: { uuid: args.uuid } });
      throw err;
    }
  },
};

export const destructiveTools = [
  restartApplication, cancelDeployment, stopApplication, deleteApplicationEnv, deleteApplication,
];
