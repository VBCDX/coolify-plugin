# Contract `vbcdx.coolify/1`: the Coolify MCP server

This document specifies `@vbcdx/coolify-plugin`: its commands, configuration, credential
handling, tool catalog, results and manifest. Where the README disagrees with it, this document
wins.

The credential-file grammar is shared with the [vbcdx installer](https://github.com/VBCDX/vbcdx),
which writes those files; agent bindings are the installer's too. This document owns the Coolify
server, its launch settings, service authentication, tools and write controls. Forgejo
has a separate service contract (`vbcdx.forgejo/1`) and separate credentials.

## 1. Package and protocol

`@vbcdx/coolify-plugin` is an ES-module Node.js package (Node 22 or later) with the executable `vbcdx-coolify` (`bin/vbcdx-coolify.js`). It ships runnable JavaScript with no build step, and the MCP SDK version is pinned. The package installs no agents, provisions no accounts or tokens and enables no Coolify API.

Commands:

* `vbcdx-coolify mcp`: stdio MCP server; no secret, URL, role selector or credential-path CLI options.
* `vbcdx-coolify serve`: the same catalog as an MCP server over Streamable HTTP (section 3), the token per request by header (section 4).
* `vbcdx-coolify healthcheck`: probe a locally running `serve` endpoint; exit 0 when healthy, 1 otherwise.
* `vbcdx-coolify manifest`: deterministic nonsecret JSON tool contract, with no network, credential reads or server startup.
* `vbcdx-coolify --help` / `--version`: output and exit. Unknown commands/options exit 2.

Use the SDK's supported negotiated protocol versions. Initialize and expose the complete tool catalog even without service settings or credentials. Expected call failures return MCP `isError: true`; protocol malformation uses protocol errors. Only protocol frames go to stdout in `mcp`; redacted diagnostics go to stderr. EOF/SIGTERM/cancellation stop in-flight work and clean up.

Coolify also offers a native MCP endpoint. This package deliberately supplies per-call credential-file selection, a bounded tool catalog and explicit accidental-write controls. It does not claim to replace every native Coolify capability or provide stronger authorization than the OS and service token permit. Native endpoint enablement, infrastructure provisioning, backup/restore, arbitrary shell/API calls, private-key/cloud-token management and unsupported rollback/pin-to-SHA behavior are outside v1.

## 2. Installation and harness registration

The MCP identity is `coolify`; the Forgejo package uses `forgejo`. Raw tool names in section 6 carry
no repeated service prefix; each harness adds its own (`mcp__coolify__<name>` in Claude Code,
`coolify_<name>` in OpenCode).

**With the vbcdx installer.** The package ships `vbcdx.json`, the declaration
`vbcdx install tool` reads: the server name, the `mcp` launch, the settings it reads (with the run
modes that read them; section 3) and the per-call `credential_file` argument. One command
registers the server for Claude Code, Codex, OpenCode or Hermes Agent, and `vbcdx install agent`
binds each role to the tools its reviewed allowlist permits:

```sh
vbcdx install tool @vbcdx/coolify-plugin --harness=claude
vbcdx install agent devops-agent --harness=claude
```

**By hand.** Register `node <installed package>/bin/vbcdx-coolify.js mcp` (or the `vbcdx-coolify`
binary) as a stdio server with the harness's own command, passing `VBCDX_COOLIFY_URL` and
`VBCDX_COOLIFY_WRITES` in its environment. For example, Claude Code (the default scope is local,
so name one):

```sh
claude mcp add coolify --scope user \
  -e VBCDX_COOLIFY_URL=https://coolify.example.com \
  -e VBCDX_COOLIFY_WRITES=off \
  -- node /absolute/package/bin/vbcdx-coolify.js mcp
```

Codex: `codex mcp add coolify --env VBCDX_COOLIFY_URL=… --env VBCDX_COOLIFY_WRITES=off -- node …/vbcdx-coolify.js mcp`
writes `[mcp_servers.coolify]` in `$CODEX_HOME/config.toml`. OpenCode: a `mcp.coolify` entry of
`"type": "local"` with `"command": ["node", "…/vbcdx-coolify.js", "mcp"]` and the two settings in
`"environment"`, in the operator's chosen configuration root (respect an explicitly set
`OPENCODE_CONFIG_DIR`). OpenCode's MCP `timeout` concerns tool discovery; do not take it for the
call deadline.

Production setups pin an immutable artifact (a published version, or a reviewed commit); do not
fetch a moving branch at every launch, and never put credentials in a package or repository URL.
The package never edits the installer's configuration or another server's entry. Keep service
registration separate from agent installation: a Forgejo token is never usable as a Coolify
credential because its key has the same name.

## 3. Server configuration and request limits

Read nonsecret `VBCDX_COOLIFY_URL` (required for an API call), `VBCDX_COOLIFY_WRITES` (`off` default, `write`, `full`), and `VBCDX_COOLIFY_TIMEOUT_MS` (total call budget, integer 1000–120000, default 30000). Settings are isolated per process/instance, not module-global mutable state. No root-token, env-file, home-directory search, startup role, `CODE_HOST_*` or ambient `VBCDX_AGENTS_*` secret fallback.

Normalize an HTTP(S) instance URL with optional deployment prefix and optional final `/api/v1`; append the API suffix once. Reject userinfo, query, fragment, control characters, unsafe path components and malformed values. Explicit trusted-network HTTP is allowed and noted once without printing secret-bearing input; never disable TLS verification. Build only catalog routes beneath the configured API origin/prefix, encode path/query components, reject redirects, and never forward authentication to arbitrary/off-origin URLs.

Invalid configuration remains visible as a tool error rather than removing all tools from discovery. An invalid write setting behaves as off. Never quote an unvalidated setting value that could contain a token. Service timeout spans file read, preflight if any, mutation and verification; it is not reset for each request. Propagate cancellation, do not automatically retry requests in v1, and never replay an uncertain mutation.

Limit upstream bodies to 2 MiB before parsing and tool envelopes to 256 KiB. Text/log excerpts are at most 64 KiB with explicit truncation. An oversized/malformed JSON document is an error, not an empty list. Configure the harness call deadline above the server budget or reduce the server budget and test the actual outcome. A 5-second discovery timeout cannot be treated as a 5-second API-call limit.

`serve` (network mode) also reads these settings, which no stdio entry carries (`vbcdx.json` marks
them `"modes": ["http"]`):

* `VBCDX_COOLIFY_HTTP_PORT`: listen port, default 8080.
* `VBCDX_COOLIFY_HTTP_HOST`: bind address, default `127.0.0.1` (loopback only); the container image sets `0.0.0.0`.
* `VBCDX_COOLIFY_TLS_CERT` and `VBCDX_COOLIFY_TLS_KEY`: PEM paths to serve HTTPS directly; both or neither. Otherwise plain HTTP, for use behind a TLS-terminating proxy or on a trusted local network, which `serve` logs at startup.
* `VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS`: comma-separated browser origins (`scheme://host[:port]`, no wildcards). A request carrying any other `Origin` is refused with 403 (DNS-rebinding protection); server-to-server clients send none. An invalid entry stops `serve` at startup.

`serve` exposes `POST /mcp` (Streamable HTTP, stateless: a fresh server per request) and
`GET /healthz`, which returns only status, service, contract and the tool count. A request body over
1 MiB is refused before any credential is checked. A setting whose value is exactly an unexpanded
reference such as `${VBCDX_COOLIFY_TIMEOUT_MS}` counts as unset, because some harnesses pass a
reference to an unset variable through as text. `VBCDX_COOLIFY_TLS_CERT`, `VBCDX_COOLIFY_TLS_KEY`
and `VBCDX_COOLIFY_HTTP_HOST` are the exceptions: an unexpanded value there stops `serve` with an
error naming the setting, rather than falling back to cleartext or a wider bind. The outbound
connection to Coolify always verifies TLS.

## 4. Credential file and actual Coolify authentication

Every tool except public `health` requires an explicit absolute `credential_file`. Read exactly that file at call time; no other path, token argument, directory scan, role lookup, ambient secret or between-call credential cache. Retain one validated credential snapshot for the duration of a multi-request call so rotation cannot switch identity midway.

Use the installer's literal UTF-8 grammar and quoting: no sourcing or interpolation; dollars and equals remain literal; reject duplicate keys, malformed quoting and decoded control/line-break values. Require a regular nonsymlink file owned by the effective user at 0600 in a private immediate parent at 0700, with no symlink components and safe replacement handling. v1 targets POSIX; do not skip protection on other platforms and claim equivalent support.

The file contains canonical `VBCDX_AGENTS_ROLE` and nonblank `VBCDX_AGENTS_TOKEN`. `VBCDX_AGENTS_USER` and `VBCDX_AGENTS_PASSWORD` may be present under the shared format but are not used for Coolify authentication. ROLE is descriptive and conveys no authority. Reject malformed/duplicate known fields and unsupported `VBCDX_AGENTS_*` credential fields; do not print unrelated values. A token-only service file is valid.

Send the complete token as `Authorization: Bearer <token>`. Coolify authenticates protected APIs with Bearer tokens: **there is no password fallback**. Blank/missing token is a local error. A 401 is reported; a 403 is reported without another identity or broader credential. A file issued for Forgejo is not usable merely because it has a TOKEN key.

Examples of fixed errors, returned with `isError: true` and `outcome: refused` before network:

```text
Credential file not found: /home/example/.config/vbcdx/coolify/devops-agent.env.
Expected a regular owned file, mode 0600, in a private 0700 directory:
VBCDX_AGENTS_ROLE=devops-agent
VBCDX_AGENTS_TOKEN=<Coolify API token>
No Coolify request was attempted. A password cannot authenticate this API.
```

Use `credential_not_absolute`, `credential_missing`, `credential_unreadable`, `credential_unsafe`, `credential_malformed`, or `credential_key_missing` as appropriate; errors identify path and key/format, never content. Invalid token uses `credential_rejected`; 403 uses `permission_denied` with endpoint permission guidance. Escape paths safely and omit raw upstream/OS buffers and authorization headers.

Coolify `read`, `read:sensitive`, `write`, `deploy` and `root` are distinct permissions, scoped to the token's team and user's role. A deploy-only token is legitimate and must not be blocked merely because a GET preflight would require read. The server does not infer permission from ROLE, decode token authority, or claim that every 403 means only a missing token scope. Team access, owner role, API enablement and IP allowlists also matter.

In `serve` there is no credential file and no `credential_file` argument. Each request carries the
Coolify API token in its `Authorization` header as `Bearer <token>` (the `token` scheme is accepted
as a synonym; there is no Basic, since Coolify has no password authentication). It is used for that
request only, never cached, and redacted from that request's output without affecting concurrent
callers. Discovery works without a credential; a call without one returns an actionable, redacted
refusal, and no part of a malformed header is echoed. Credentials are never read from the
environment in either mode.

## 5. Write controls and honest results

Every tool has explicit effect metadata. `off` permits only read; `write` also permits ordinary configuration/deploy writes; `full` additionally permits destructive tools with exact target confirmation. All tools remain listed and disabled calls return an explicit refusal. Gates run before file reads and HTTP. Helpers/composite tools apply the same rules. Read tools issue GET only.

Destructive v1 calls are restart/stop application, cancel deployment, delete environment variable and delete application. They can interrupt service or discard work/data. Their confirmation strings after outer trim are:

* `restart application <uuid>`
* `stop application <uuid> docker_cleanup=<true|false>`
* `cancel deployment <uuid>`
* `delete env <env_uuid> of application <uuid>`
* `delete application <uuid> delete_configurations=<true|false> delete_volumes=<true|false> delete_connected_networks=<true|false> docker_cleanup=<true|false>`

All delete/cleanup booleans default false and are sent explicitly. Do not omit them and inherit Coolify's true defaults. The confirmation binds the actual normalized target/options; it is not sent upstream. It is an accident interlock, not proof of human approval. Credentials/server permissions, OS file access and native harness controls provide the real limits; an agent that can edit config or read stronger credentials is outside this interlock. Never claim the server can guarantee separation of duties or prevent every destructive/self-approved action.

A call returns complete text and matching `structuredContent` conforming to its declared outputSchema. Required fields: `outcome`, `effect`, `request:{method,path,attempted}`, `verification`. Optional `http_status` exists when received. `data` appears only for ok/accepted; other outcomes carry required `reason`/`message` and optional redacted evidence (IDs, observed statuses, verification/partial-effect information). `attempted` means the primary API operation was dispatched, not proof it reached the server; distinguish any preflight HTTP requests in diagnostics.

Outcomes:

| Outcome | isError | Meaning |
| --- | --- | --- |
| ok | false | Read succeeded, or synchronous configuration change verified |
| accepted | false | API acknowledged queued lifecycle work; not proof of completion, health or serving |
| refused | true | Local input/config/credential/gate failure before network |
| failed | true | Read/preflight failed or API explicitly rejected operation |
| unverified | true | Mutation returned a valid acknowledgement but state could not be confirmed |
| indeterminate | true | Mutation may have applied; timeout/reset, ambiguous 5xx or malformed 2xx prevents a reliable answer |

Verification is `not_applicable`, `confirmed`, `pending`, `unavailable` or `mismatch`. Fixed reasons additionally include `validation_failed`, `server_not_configured`, `write_gate_disabled`, `confirmation_required`, `confirmation_mismatch`, `not_found`, `conflict`, `rate_limited`, `upstream_error`, `network_error`, `timeout`, `response_too_large`, `unexpected_response`, `verification_failed`, `data_unavailable`, `indeterminate_write`, `unsupported_operation`. Preserve safe HTTP status/Retry-After, not arbitrary success flags or human-readable upstream bodies.

HTTP status is the first check, followed by the documented response shape. A 403 containing `success:true` is a failure. A 2xx alone is not completion; missing documented write identifiers is indeterminate, not a safe-to-retry failure. Never promise “nothing changed” after dispatch. No automatic write retries or credential escalation.

Configuration mutations use read-back with the same credential snapshot: compare supplied fields/identity, never an entire unrelated object. If read or sensitive-read access is unavailable, the result is unverified and explains that the write may have applied; do not retry the mutation or borrow a read/root token. A masked environment value cannot verify an exact value. Return only a comparison result, never echo a secret value in verification/errors.

Lifecycle calls (deploy/start/restart/stop/cancel) do not require a GET preflight and return accepted after valid acknowledgement, retaining upstream identifiers/statuses. This permits deploy-only tokens. Polling is a separate explicit read call with an appropriate credential. Raw deployment/application statuses are preserved; no substring test maps unhealthy to healthy, and finished deployment does not prove endpoint availability. The server makes no arbitrary user-supplied URL health probes.

For env deletion, resolve the specific env UUID from a preflight list, remember its key/context, delete that exact UUID and verify absence of that UUID; another same-key preview variable must not cause a false failure. For application deletion, preflight the exact UUID with read access, send explicit flags, and verify absence. A 404 before mutation is not a successful deletion; a confirming 404 afterward is meaningful only under the same identity/access context. If deletion is still queued, report accepted/pending; do not claim all volumes vanished based on the application row disappearing.

## 6. Exact v1 tool catalog

There are 27 tools. Every row except health additionally requires `credential_file`. `uuid`/`env_uuid` are nonempty strings up to 255 characters, validated as one encoded path component without controls, separators or traversal. Required strings are nonempty unless explicitly allowed (env values may be empty). Unknown inputs are rejected. `?` marks optional. List `offset?` defaults 0, nonnegative; `limit?` defaults 25, range 1–100. Local list windows are specified below; no unsupported Coolify query pagination is invented.

Projection types (only listed fields; optional fields omitted when absent):

* Application: `uuid,name,fqdn,status,git_repository,git_branch,git_commit_sha,build_pack,environment_id,updated_at`. Detail may also include `docker_compose_location,health_check_path,ports_exposes,limits_memory,limits_cpus`; never raw settings/Compose/secrets.
* Resource: `uuid,name,status,type` where type is the known source kind application/database/service.
* Server: `uuid,name,description,ip,port,proxy_type,unreachable_count`; no private keys or validation logs.
* Project: `uuid,name,description`.
* Deployment: `deployment_uuid,application_id,application_name,status,commit,commit_message,created_at,updated_at,server_name,deployment_url,is_api,restart_only,rollback`; no bundled logs/event dumps.
* Env: `uuid,key,is_preview,is_literal,is_multiline,is_shown_once,is_buildtime,is_runtime,comment,value_state`; `value` only if deliberately requested and actually present/unredacted. `value_state` is `not_requested`, `available`, `redacted` or `absent`; preserve actual empty strings, never substitute them for hidden values.

The last column gives the manifest's `effect`, then its `required_permissions`.

| Tool | Additional inputs | API operation / data | Effect; permissions |
| --- | --- | --- | --- |
| `health` | none | GET `/health`, no auth → `{ok:true,body:"OK"}` only for expected successful health response | read; public |
| `version` | none | GET `/version`, documented text response → `{version:string}`; trim transport newline, no invented JSON requirement | read; read |
| `list_applications` | tag?, offset?, limit? | GET `/applications` with optional tag → window of Application | read; read |
| `get_application` | uuid | GET `/applications/{uuid}` → Application detail | read; read |
| `get_application_logs` | uuid, `include_sensitive:true`, lines?=100 (1–1000), show_timestamps?=false | GET application `/logs` → `{logs,truncated,value_state}`; missing/masked data is explicit, not empty success | read; read, read:sensitive |
| `list_application_envs` | uuid, include_values?=false, offset?, limit? | GET application `/envs` → window of Env; explicit opt-in required for returned values | read; read, read:sensitive |
| `list_databases` | offset?, limit? | GET `/databases` → window of Resource(type=database) | read; read |
| `get_database` | uuid | GET `/databases/{uuid}` → Resource(type=database); no credential-bearing URLs | read; read |
| `list_services` | offset?, limit? | GET `/services` → window of Resource(type=service) | read; read |
| `get_service` | uuid | GET `/services/{uuid}` → Resource(type=service) | read; read |
| `list_projects` | offset?, limit? | GET `/projects` → window of Project | read; read |
| `get_project` | uuid | GET `/projects/{uuid}` → Project | read; read |
| `list_servers` | offset?, limit? | GET `/servers` → window of Server | read; read |
| `get_server` | uuid | GET `/servers/{uuid}` → Server | read; read |
| `list_resources` | offset?, limit? | Combine GET `/applications`, `/databases`, `/services` into a window of Resource, sorted by type then uuid | read; read |
| `list_deployments` | offset?, limit? | GET `/deployments` → window of Deployment; currently running/queued work, not history | read; read |
| `get_deployment` | uuid | GET `/deployments/{uuid}` → Deployment, status verbatim | read; read |
| `create_application` | project_uuid, server_uuid, exactly one of environment_name/environment_uuid, git_repository, git_branch, build_pack; name?, description?, domains?, ports_exposes?, destination_uuid? | POST `/applications/public`, explicitly instant_deploy=false → `{uuid,application:Application}` after read-back | write; write, read |
| `deploy` | exactly one of uuid/tag, force?=false, docker_tag? | POST `/deploy` with query parameters → `{deployments:[{resource_uuid,deployment_uuid,message?}]}`; accepted only | write; deploy |
| `start_application` | uuid, force?=false, instant_deploy?=false | POST application `/start` with explicit query flags → `{deployment_uuid,message?}`; accepted | write; deploy |
| `restart_application` | uuid, confirm | POST application `/restart` → `{deployment_uuid,message?}`; accepted | destructive; deploy |
| `cancel_deployment` | uuid, confirm | POST deployment `/cancel` → `{deployment_uuid,status,message?}`; accepted, status verbatim | destructive; deploy |
| `create_application_env` | uuid, key, value (may be empty), `is_preview`; is_literal?, is_multiline?, is_shown_once? | POST application `/envs` → `{uuid,key,is_preview,verified:true,affected_contexts?}` only after identity/value/context read-back | write; write, read, read:sensitive |
| `update_application_env` | uuid, key, value (may be empty), `is_preview`; is_literal?, is_multiline?, is_shown_once? | PATCH application `/envs`, identifies key/context → same verified data shape | write; write, read, read:sensitive |
| `stop_application` | uuid, confirm, docker_cleanup?=false | POST application `/stop` with explicit docker_cleanup → `{uuid,message?}`; accepted | destructive; deploy |
| `delete_application_env` | uuid, env_uuid, confirm | GET env list, DELETE `/applications/{uuid}/envs/{env_uuid}`, verify exact UUID absent → `{uuid,env_uuid,deleted:true}` | destructive; write, read |
| `delete_application` | uuid, confirm, delete_configurations?=false, delete_volumes?=false, delete_connected_networks?=false, docker_cleanup?=false | GET application, DELETE `/applications/{uuid}` with all query flags explicit; verify disappearance or report pending → `{uuid,deleted:true}` only if confirmed | destructive; write, read |

`read:sensitive` is needed only for the sensitive content: log text, env values on request, and the exact-value read-back of an env write (without it the write reports unverified). `build_pack` is exactly nixpacks/railpack/static/dockerfile/dockercompose. `git_repository` is a public HTTP(S) repository URL without userinfo; no private-key/GitHub-app provisioning. `domains` is the documented comma-separated HTTP(S) domain string; `ports_exposes` is validated comma-separated numeric ports, `name` <=255 chars, description <=8192 chars. Environment variable `key` is a nonempty <=255-character literal key without NUL/line breaks; value <=64 KiB, preserving empty/multiline content as an API value. Reject unsupported write fields, including `is_buildtime`, `is_runtime` and comment in v1 env mutations: the Coolify OpenAPI create/update schemas expose only key/value/is_preview/is_literal/is_multiline/is_shown_once. Read projections may expose metadata that write endpoints do not accept.

Environment context is explicit. Test the supported version's production/preview mirroring behavior. If a creation also creates a preview entry, report affected contexts when observable; never promise that another context was untouched merely because only one flag was submitted. Failed verification or redacted values produce unverified, never a second create/update attempt.

Lists return `{items,count,offset,limit,total,next_offset,truncated}` after fully reading the bounded documented upstream array. Count is items returned, total is the visible upstream-array length (not all resources in other teams), next_offset is null at the end. The offset/limit window is local and not atomic across calls if upstream data changes. Do not send invented pagination query parameters. Over-limit upstream documents fail before partial JSON is used. `list_resources` deliberately uses the three documented typed list responses because `/resources`' OpenAPI response is a placeholder; it does not guess that endpoint's shape. If a component fetch fails, return failed with component/partial-request evidence, not a success claiming a complete inventory.

Sensitive values are never included in summaries or automatically attached to errors. Env values require include_values=true and service permission; logs require include_sensitive=true and service permission. Preserve upstream redaction, remove current API credential values from diagnostics/output, and do not claim a generic log filter can recognize every application secret. Operators control whether these explicit sensitive tools are available to a role.

Unsupported v1 operations are explicit: service/database creation or deletion, infrastructure or server provisioning, backup/restore, private/cloud keys, Git provider apps, global settings, team/admin functions, proxies, arbitrary app PATCH, environment bulk updates, shared env vars, deployment-history/log tooling beyond this table, and pin/rollback-to-SHA. New tools require a contract change, endpoint/effect/permission/projection definition, request and failure tests, and review.

## 7. Manifest and declaration

`manifest` emits exactly `schema_version:1`, `service:"coolify"`, `contract:"vbcdx.coolify/1"`,
`package_version`, `tools`. Each tools entry has `name`, `description`, `inputSchema`,
`outputSchema`, `effect`, `required_permissions` string array; entries are sorted by name and
serialized deterministically. The runtime registry generates this manifest and its schemas; there
is no separate handwritten list. It contains no secret, role-file path, install root or native
harness prefix.

`vbcdx.json` at the package root declares the server for the vbcdx installer: `server_name` `coolify`,
`contract` `vbcdx.coolify/1`, the `mcp` stdio launch, the `serve` http mode with its port setting,
every setting the server reads with its run modes, the `credential_file` argument, and the manifest
command. `vbcdx install tool` validates it, runs the manifest, and binds roles by contract; a file
binding is explicit for each service and role, and another service's token never activates it. The
manifest proves an offline interface; a real MCP `tools/list` and call verify the registration.

## Sources

[Coolify authorization](https://coolify.io/docs/api/authorization),
[permissions](https://coolify.io/docs/api/permissions),
[official OpenAPI](https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml),
[native MCP](https://coolify.io/docs/integrations/mcp),
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[Claude Code MCP](https://code.claude.com/docs/en/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/).
