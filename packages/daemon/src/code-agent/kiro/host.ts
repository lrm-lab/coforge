import type { KiroRuntimeHost } from "@lrm/coforge-anvil";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { readKiroUsageResponse } from "./usage-host";

export const kiroRuntimeHost: KiroRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  readUsageResponse: readKiroUsageResponse,
  buildEnvironment: (options) =>
    agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
    }),
  buildCatalogEnvironment: (environment) => agentEnvironment(undefined, environment),
};
