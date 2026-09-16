// Tool manifest (§7).
//
// Deterministic, nonsecret JSON tool contract generated from the runtime registry
// — no separate handwritten list. It contains no secret, role-file path, install
// root, or native harness prefix.

import { CONTRACT, SCHEMA_VERSION, SERVICE } from './contract.js';
import { listTools } from './registry.js';
import { packageVersion } from './version.js';

/**
 * Build the manifest object.
 * @returns {{schema_version:number, service:string, contract:string, package_version:string, tools:object[]}}
 */
export function buildManifest() {
  const tools = listTools()
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      effect: t.effect,
      required_permissions: t.required_permissions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    schema_version: SCHEMA_VERSION,
    service: SERVICE,
    contract: CONTRACT,
    package_version: packageVersion(),
    tools,
  };
}

/** Deterministic JSON serialization of the manifest. */
export function manifestJson() {
  return JSON.stringify(buildManifest(), null, 2);
}
