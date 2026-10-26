import { GrokProvider, type GrokRuntimeHost, type GrokProviderOptions } from "@lrm/coforge-anvil";
import { fixturePerTurnHost, fixtureVersionReader } from "./runtime-host";

export const fixtureGrokHost: GrokRuntimeHost = {
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  versionReader: fixtureVersionReader,
  sessionClientInfo: { name: "fixture-session", version: "9.8.7-session" },
  catalogClientInfo: { name: "fixture-catalog", version: "9.8.7-catalog" },
  usageClientInfo: { name: "fixture-usage", version: "9.8.7-usage" },
  buildSessionEnvironment: (options) => ({
    ...options.runtime?.envVars,
    ...options.environment,
    PWD: options.agentWorkspaceDirectory,
    NO_COLOR: "1",
  }),
  buildCatalogEnvironment: (environment) =>
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  buildUsageEnvironment: (environment) => ({ ...environment }),
  createReplyIntentScanner: () => ({ feed: () => undefined, complete: () => {}, reset: () => [] }),
  isShellToolName: (name) => name === "run_terminal_command",
  maskAccountLabel: () => undefined,
};

export function grokProvider(options: Omit<GrokProviderOptions, "host"> = {}) {
  return new GrokProvider({ ...options, host: fixtureGrokHost });
}
