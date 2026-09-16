# Registering the coolify MCP server

The MCP identity is `coolify`. Register `node /absolute/package/bin/vbcdx-coolify.js mcp`
against each harness. Replace `/absolute/package` with the real installed path
(from a packed, reviewed artifact — see the README). Credentials are never passed
on the command line; each tool call carries an absolute `credential_file` argument.

## Claude Code

```sh
claude mcp add coolify --scope user \
  -e VBCDX_COOLIFY_URL=https://coolify.example.com \
  -e VBCDX_COOLIFY_WRITES=off \
  -- node /absolute/package/bin/vbcdx-coolify.js mcp
```

## Codex

```sh
codex mcp add coolify \
  --env VBCDX_COOLIFY_URL=https://coolify.example.com \
  --env VBCDX_COOLIFY_WRITES=off \
  -- node /absolute/package/bin/vbcdx-coolify.js mcp
```

## OpenCode

Merge `examples/opencode.json` into your `opencode.json`/`opencode.jsonc` or the
user config, honoring any explicitly set `OPENCODE_CONFIG_DIR`.

## DSH

```sh
dsh plugin --profile web add <reviewed-package-or-absolute-root>
```

Set `VBCDX_COOLIFY_ENTRYPOINT` to the absolute installed `bin/vbcdx-coolify.js`
before starting the profile (see `cordis.patch.yml`). The bridge exposes tools as
`mcp__coolify__<raw_name>`.
