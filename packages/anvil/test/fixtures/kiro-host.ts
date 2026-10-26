import {
  KiroProvider,
  type KiroRuntimeHost,
  type KiroProviderOptions,
} from "@lrm/coforge-anvil/kiro";
import { fixturePerTurnHost, fixtureVersionReader } from "./runtime-host";

/** Fixture I/O only; daemon tests cover real environment and native credential composition. */
export const fixtureKiroHost: KiroRuntimeHost = {
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  clientInfo: { name: "fixture-host", version: "0.1.0-fixture" },
  versionReader: fixtureVersionReader,
  readUsageResponse: async () => undefined,
  buildEnvironment: (options) => ({ ...options.runtime?.envVars, ...options.environment }),
  buildCatalogEnvironment: (environment) =>
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
};

export function kiroProvider(options: Omit<KiroProviderOptions, "host"> = {}) {
  return new KiroProvider({ ...options, host: fixtureKiroHost });
}
