// Read tools (§6). Every read issues GET only and never turns an error into an
// empty list: a non-2xx status, a malformed body, or an unexpected shape is a
// failure, not zero results.

import { MAX_TEXT_BYTES } from '../contract.js';
import {
  projectApplication, projectDeployment, projectEnv, projectProject,
  projectResource, projectServer,
} from '../projections.js';
import {
  HttpError, failed, listDataSchema, limitField, mapHttpStatus, mapTransportError,
  offsetField, ok, req, uuidField, windowList,
} from './common.js';

/**
 * Run a GET and interpret the response with `onOk(res)`, which returns the data
 * object for an ok envelope. Status is checked before shape.
 */
async function get(client, { segments, query, auth = true }, effect, onOk) {
  const path = client.pathFor(segments, query);
  const request = req('GET', path, true);
  try {
    const res = await client.request({ method: 'GET', segments, query, auth });
    if (!res.ok) return mapHttpStatus(res, effect, request);
    return onOk(res, request);
  } catch (err) {
    if (err instanceof HttpError) return mapTransportError(err, effect, request);
    throw err;
  }
}

function expectArray(res, request, effect) {
  if (!Array.isArray(res.json)) {
    return failed(effect, request, 'unexpected_response',
      'The API did not return the documented array shape.', { http_status: res.status });
  }
  return null;
}

function expectObject(res, request, effect) {
  if (!res.hasJson || res.json === null || typeof res.json !== 'object' || Array.isArray(res.json)) {
    return failed(effect, request, 'unexpected_response',
      'The API did not return the documented object shape.', { http_status: res.status });
  }
  return null;
}

/** health — GET /health, no auth, expects the plain text OK response. */
const health = {
  name: 'health',
  description: 'Check the Coolify instance health endpoint. No credentials required.',
  effect: 'read',
  permissions: ['public'],
  publicRoute: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  dataSchema: { type: 'object', additionalProperties: false, properties: { ok: { const: true }, body: { type: 'string' } } },
  route: () => ({ method: 'GET', segments: ['health'] }),
  run: ({ client }) => get(client, { segments: ['health'], auth: false }, 'read', (res, request) => {
    const body = (res.text || '').trim();
    if (res.status === 200 && body === 'OK') {
      return ok('read', request, { ok: true, body: 'OK' }, 'confirmed', res.status);
    }
    return failed('read', request, 'unexpected_response',
      'The health endpoint did not return the expected OK response.', { http_status: res.status });
  }),
};

/** version — GET /version, text response. */
const version = {
  name: 'version',
  description: 'Get the Coolify instance version.',
  effect: 'read',
  permissions: ['read'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  dataSchema: { type: 'object', additionalProperties: false, properties: { version: { type: 'string' } } },
  route: () => ({ method: 'GET', segments: ['version'] }),
  run: ({ client }) => get(client, { segments: ['version'] }, 'read', (res, request) => {
    // Documented text response; trim the transport newline. If JSON was returned,
    // accept a {version} field but do not invent a JSON requirement.
    let value = '';
    if (res.hasJson && res.json && typeof res.json === 'object' && typeof res.json.version === 'string') {
      value = res.json.version.trim();
    } else {
      value = (res.text || '').trim();
    }
    if (value === '') {
      return failed('read', request, 'unexpected_response', 'The version endpoint returned an empty response.', { http_status: res.status });
    }
    return ok('read', request, { version: value }, 'confirmed', res.status);
  }),
};

function listTool({ name, description, segments, projectFn, extraInput = {}, permissions = ['read'] }) {
  return {
    name,
    description,
    effect: 'read',
    permissions,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...extraInput, offset: offsetField, limit: limitField },
    },
    dataSchema: listDataSchema,
    route: (args) => ({ method: 'GET', segments, query: name === 'list_applications' && args && args.tag ? { tag: args.tag } : {} }),
    run: ({ args, client }) => {
      const query = {};
      if (name === 'list_applications' && args.tag) query.tag = args.tag;
      return get(client, { segments, query }, 'read', (res, request) => {
        const bad = expectArray(res, request, 'read');
        if (bad) return bad;
        return ok('read', request, windowList(res.json, args.offset, args.limit, projectFn), 'confirmed', res.status);
      });
    },
  };
}

function getTool({ name, description, segments, projectFn, permissions = ['read'] }) {
  return {
    name,
    description,
    effect: 'read',
    permissions,
    inputSchema: {
      type: 'object',
      required: ['uuid'],
      additionalProperties: false,
      properties: { uuid: uuidField },
    },
    dataSchema: { type: 'object', additionalProperties: true },
    route: (args) => ({ method: 'GET', segments: segments(args || {}) }),
    run: ({ args, client }) => get(client, { segments: segments(args) }, 'read', (res, request) => {
      const bad = expectObject(res, request, 'read');
      if (bad) return bad;
      return ok('read', request, projectFn(res.json), 'confirmed', res.status);
    }),
  };
}

const listApplications = listTool({
  name: 'list_applications',
  description: 'List applications (optionally filtered by tag).',
  segments: ['applications'],
  projectFn: (a) => projectApplication(a),
  extraInput: { tag: { type: 'string', maxLength: 255, description: 'Optional tag filter.' } },
});

const getApplication = getTool({
  name: 'get_application',
  description: 'Get one application by UUID.',
  segments: (a) => ['applications', a.uuid],
  projectFn: (a) => projectApplication(a, { detail: true }),
});

const getApplicationLogs = {
  name: 'get_application_logs',
  description: 'Get recent application logs. Requires explicit include_sensitive:true and a token with read:sensitive.',
  effect: 'read',
  permissions: ['read', 'read:sensitive'],
  inputSchema: {
    type: 'object',
    required: ['uuid', 'include_sensitive'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      include_sensitive: { const: true, description: 'Must be true to acknowledge logs may contain secrets.' },
      lines: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Lines from the end (1–1000, default 100).' },
      show_timestamps: { type: 'boolean', default: false, description: 'Include timestamps (default false).' },
    },
  },
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { logs: { type: 'string' }, truncated: { type: 'boolean' }, value_state: { type: 'string' } },
  },
  route: (args) => ({ method: 'GET', segments: ['applications', args && args.uuid, 'logs'] }),
  run: ({ args, client }) => get(
    client,
    { segments: ['applications', args.uuid, 'logs'], query: { lines: args.lines, show_timestamps: args.show_timestamps } },
    'read',
    (res, request) => {
      const bad = expectObject(res, request, 'read');
      if (bad) return bad;
      const rawLogs = typeof res.json.logs === 'string' ? res.json.logs : null;
      if (rawLogs === null) {
        // Missing content is explicit, never a silent empty success.
        return ok('read', request, { logs: '', truncated: false, value_state: 'absent' }, 'confirmed', res.status);
      }
      let logs = rawLogs;
      let truncated = false;
      if (Buffer.byteLength(logs, 'utf8') > MAX_TEXT_BYTES) {
        logs = Buffer.from(logs, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8');
        truncated = true;
      }
      return ok('read', request, { logs, truncated, value_state: 'available' }, 'confirmed', res.status);
    },
  ),
};

const listApplicationEnvs = {
  name: 'list_application_envs',
  description: 'List an application\'s environment variables (metadata only unless include_values:true and the token has read:sensitive).',
  effect: 'read',
  permissions: ['read', 'read:sensitive'],
  inputSchema: {
    type: 'object',
    required: ['uuid'],
    additionalProperties: false,
    properties: {
      uuid: uuidField,
      include_values: { type: 'boolean', default: false, description: 'Return values (opt-in; needs read:sensitive).' },
      offset: offsetField,
      limit: limitField,
    },
  },
  dataSchema: listDataSchema,
  route: (args) => ({ method: 'GET', segments: ['applications', args && args.uuid, 'envs'] }),
  run: ({ args, client }) => get(client, { segments: ['applications', args.uuid, 'envs'] }, 'read', (res, request) => {
    const bad = expectArray(res, request, 'read');
    if (bad) return bad;
    const data = windowList(res.json, args.offset, args.limit, (e) => projectEnv(e, { includeValues: args.include_values }));
    return ok('read', request, data, 'confirmed', res.status);
  }),
};

const listDatabases = listTool({
  name: 'list_databases',
  description: 'List databases.',
  segments: ['databases'],
  projectFn: (r) => projectResource(r, 'database'),
});
const getDatabase = getTool({
  name: 'get_database',
  description: 'Get one database by UUID.',
  segments: (a) => ['databases', a.uuid],
  projectFn: (r) => projectResource(r, 'database'),
});
const listServices = listTool({
  name: 'list_services',
  description: 'List services.',
  segments: ['services'],
  projectFn: (r) => projectResource(r, 'service'),
});
const getService = getTool({
  name: 'get_service',
  description: 'Get one service by UUID.',
  segments: (a) => ['services', a.uuid],
  projectFn: (r) => projectResource(r, 'service'),
});
const listProjects = listTool({
  name: 'list_projects',
  description: 'List projects.',
  segments: ['projects'],
  projectFn: (p) => projectProject(p),
});
const getProject = getTool({
  name: 'get_project',
  description: 'Get one project by UUID.',
  segments: (a) => ['projects', a.uuid],
  projectFn: (p) => projectProject(p),
});
const listServers = listTool({
  name: 'list_servers',
  description: 'List servers.',
  segments: ['servers'],
  projectFn: (s) => projectServer(s),
});
const getServer = getTool({
  name: 'get_server',
  description: 'Get one server by UUID.',
  segments: (a) => ['servers', a.uuid],
  projectFn: (s) => projectServer(s),
});
const listDeployments = listTool({
  name: 'list_deployments',
  description: 'List currently running/queued deployments (not history).',
  segments: ['deployments'],
  projectFn: (d) => projectDeployment(d),
});
const getDeployment = getTool({
  name: 'get_deployment',
  description: 'Get one deployment by UUID (status verbatim).',
  segments: (a) => ['deployments', a.uuid],
  projectFn: (d) => projectDeployment(d),
});

/**
 * list_resources composes the three documented typed list responses, because the
 * /resources OpenAPI response is a placeholder. A failed component is reported as
 * failed with partial evidence, never a success claiming a complete inventory.
 */
const listResources = {
  name: 'list_resources',
  description: 'List applications, databases and services combined, sorted by type then uuid.',
  effect: 'read',
  permissions: ['read'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { offset: offsetField, limit: limitField },
  },
  dataSchema: listDataSchema,
  route: () => ({ method: 'GET', segments: ['applications'] }),
  run: async ({ args, client }) => {
    const components = [
      { segments: ['applications'], type: 'application' },
      { segments: ['databases'], type: 'database' },
      { segments: ['services'], type: 'service' },
    ];
    const request = req('GET', client.pathFor(['applications']), true);
    const all = [];
    for (const comp of components) {
      const compPath = client.pathFor(comp.segments);
      try {
        const res = await client.request({ method: 'GET', segments: comp.segments });
        if (!res.ok) {
          const env = mapHttpStatus(res, 'read', request);
          env.evidence = { ...(env.evidence || {}), failed_component: compPath };
          return env;
        }
        if (!Array.isArray(res.json)) {
          return failed('read', request, 'unexpected_response',
            'A component list did not return the documented array shape.',
            { http_status: res.status, evidence: { failed_component: compPath } });
        }
        for (const r of res.json) all.push(projectResource(r, comp.type));
      } catch (err) {
        if (err instanceof HttpError) {
          const env = mapTransportError(err, 'read', request);
          env.evidence = { ...(env.evidence || {}), failed_component: compPath };
          return env;
        }
        throw err;
      }
    }
    all.sort((a, b) => (a.type === b.type ? String(a.uuid).localeCompare(String(b.uuid)) : a.type.localeCompare(b.type)));
    return ok('read', request, windowList(all, args.offset, args.limit, (x) => x), 'confirmed', 200);
  },
};

export const readTools = [
  health, version,
  listApplications, getApplication, getApplicationLogs, listApplicationEnvs,
  listDatabases, getDatabase, listServices, getService,
  listProjects, getProject, listServers, getServer,
  listResources, listDeployments, getDeployment,
];
