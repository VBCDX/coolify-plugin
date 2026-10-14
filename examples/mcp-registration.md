# Registering the coolify MCP server

Use the server name `coolify`. Register `node /absolute/package/bin/vbcdx-coolify.js mcp`
(or the `vbcdx-coolify mcp` command after `npm install -g @vbcdx/coolify-plugin`) with each
harness. Replace `/absolute/package` with the installed package path. Credentials are never passed
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
