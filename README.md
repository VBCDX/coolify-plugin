# @vbcdx/coolify-plugin

An [MCP](https://modelcontextprotocol.io) server for the [Coolify](https://coolify.io) v4 API. It
gives AI agents a fixed set of 27 tools for applications, deployments, environment variables,
databases, services, projects and servers, with a write gate and verified results.

- Runs over **stdio** (for a local agent harness) or **Streamable HTTP** (as a network service or
  container).
- **Write gate:** reads only by default. Writes and destructive operations need explicit opt-in.
- **Per-call credentials:** each call names the credential file it uses, so several agents can
  share one server with their own tokens.
- **Verified results:** a write that cannot be confirmed is reported as unverified, never as
  success, and is never retried. `deploy`, `start_application`, `restart_application`,
  `stop_application` and `cancel_deployment` return `accepted`: Coolify took the request, but the
  tool does not wait for the result.

Coolify also ships a native MCP endpoint. This package covers a smaller, fixed set of operations
and adds per-call credentials and the write gate.

The full specification is in [docs/contract.md](docs/contract.md).

## Requirements

- Node.js 22 or later
- A Coolify v4 instance and an API token for it

## Install

```sh
npm install -g @vbcdx/coolify-plugin
```

This installs the `vbcdx-coolify` command. To run it without installing:

```sh
npx -y --package=@vbcdx/coolify-plugin vbcdx-coolify --help
```

## Usage

```text
vbcdx-coolify mcp          Start the stdio MCP server (default)
vbcdx-coolify serve        Start the network MCP server (Streamable HTTP)
vbcdx-coolify healthcheck  Probe a running serve endpoint; exit 0 if healthy
vbcdx-coolify manifest     Print the JSON tool manifest
vbcdx-coolify --help
vbcdx-coolify --version
```

### Register with an MCP client

Claude Code:

```sh
claude mcp add coolify --scope user \
  -e VBCDX_COOLIFY_URL=https://coolify.example.com \
  -e VBCDX_COOLIFY_WRITES=off \
  -- vbcdx-coolify mcp
```

Codex:

```sh
codex mcp add coolify \
  --env VBCDX_COOLIFY_URL=https://coolify.example.com \
  --env VBCDX_COOLIFY_WRITES=off \
  -- vbcdx-coolify mcp
```

For OpenCode, see [examples/opencode.json](examples/opencode.json). More detail is in
[examples/mcp-registration.md](examples/mcp-registration.md).

The package also ships a [`vbcdx.json`](vbcdx.json) declaration, so the
[vbcdx installer](https://github.com/VBCDX/vbcdx) can register it for you:

```sh
npm install -g @vbcdx/vbcdx
vbcdx install tool @vbcdx/coolify-plugin --harness=claude
```

## Configuration

Settings are read from the environment once, at startup. See [.env.example](.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `VBCDX_COOLIFY_URL` | none | Coolify instance URL, optionally ending in `/api/v1`. Required for any API call. |
| `VBCDX_COOLIFY_WRITES` | `off` | `off` (reads only), `write` (configuration and deploy writes), or `full` (also destructive tools). |
| `VBCDX_COOLIFY_TIMEOUT_MS` | `30000` | Total deadline per tool call, 1000 to 120000 ms. |

Tools are always listed. A call made without valid configuration or credentials returns an error
explaining what is missing.

### Credentials (stdio mode)

Credentials are never passed on the command line or in the environment. Every tool except
`health` takes a `credential_file` argument: the absolute path to a file like this:

```sh
VBCDX_AGENTS_ROLE=devops-agent
VBCDX_AGENTS_TOKEN=<coolify api token>
```

The file must be a regular file you own with mode `0600`, in a directory with mode `0700`:

```sh
install -d -m 0700 ~/.config/vbcdx/coolify
install -m 0600 /dev/null ~/.config/vbcdx/coolify/devops-agent.env
```

The token is sent as `Authorization: Bearer <token>`. What it can do is set by its Coolify
permissions (`read`, `read:sensitive`, `write`, `deploy`, `root`); use the narrowest one that
works. See [examples/credential-file.env.example](examples/credential-file.env.example).

## Network mode

`vbcdx-coolify serve` exposes the same tools over MCP Streamable HTTP:

```sh
VBCDX_COOLIFY_URL=https://coolify.example.com vbcdx-coolify serve
# MCP endpoint: POST http://127.0.0.1:8080/mcp
# Liveness:     GET  http://127.0.0.1:8080/healthz
```

In this mode there is no credential file. Each request carries its Coolify API token in the
`Authorization` header (`Bearer <token>` or `token <token>`), which is used for that request only.

| Variable | Default | Description |
| --- | --- | --- |
| `VBCDX_COOLIFY_HTTP_PORT` | `8080` | Listen port. |
| `VBCDX_COOLIFY_HTTP_HOST` | `127.0.0.1` | Bind address. |
| `VBCDX_COOLIFY_TLS_CERT` | none | PEM certificate path. Set together with the key to serve HTTPS. |
| `VBCDX_COOLIFY_TLS_KEY` | none | PEM private key path. |
| `VBCDX_COOLIFY_HTTP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the server. Requests with any other `Origin` header get `403`. |

Without TLS settings the server speaks plain HTTP; run it behind a TLS-terminating reverse proxy or
on a trusted network. Outbound connections to Coolify always verify TLS. Request bodies over 1 MiB
are refused with `413`.

### Docker

```sh
docker build -t vbcdx-coolify .
docker run --rm -p 8080:8080 \
  -e VBCDX_COOLIFY_URL=https://coolify.example.com \
  vbcdx-coolify
```

The image runs `serve` as a non-root user, listens on all interfaces and includes a health check.
No credentials are stored in the image.

## Tools

Run `vbcdx-coolify manifest` for every tool's input and output schema and required token
permissions.

| Effect | Tools |
| --- | --- |
| Read | `health`, `version`, `list_applications`, `get_application`, `get_application_logs`, `list_application_envs`, `list_databases`, `get_database`, `list_services`, `get_service`, `list_projects`, `get_project`, `list_servers`, `get_server`, `list_resources`, `list_deployments`, `get_deployment` |
| Write (`write` or `full`) | `create_application`, `deploy`, `start_application`, `create_application_env`, `update_application_env` |
| Destructive (`full` only) | `restart_application`, `stop_application`, `cancel_deployment`, `delete_application_env`, `delete_application` |

Destructive tools also require an exact confirmation string naming the target. The confirmation
guards against accidents; it is not an approval mechanism and is never sent to Coolify.

### Results

Each call returns a text summary and a JSON envelope with `outcome`, `effect`,
`request` (`method`, `path`, `attempted`) and `verification`; failures add a `reason` and a
`message`. HTTP status is checked before the response body, and a mutation whose outcome cannot be
confirmed is reported as `unverified` or `indeterminate`.

## Development

```sh
npm ci
npm test
node bin/vbcdx-coolify.js --help
```

## License

[MIT](LICENSE)
