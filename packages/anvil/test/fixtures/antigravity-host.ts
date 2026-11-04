import {
  AntigravityAcpProvider,
  type AntigravityAcpRuntimeHost,
  type AntigravityAcpProviderOptions,
} from "@lrm/coforge-anvil/antigravity";
import { fixtureCatalogCommand, fixturePerTurnHost, fixtureVersionReader } from "./runtime-host";

export const fixtureAntigravityHost: AntigravityAcpRuntimeHost = {
  clientInfo: { name: "coforge-test", version: "0.0.0" },
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  versionReader: fixtureVersionReader,
  catalogCommandRunner: fixtureCatalogCommand,
  readUsageEnvironment: () => ({}),
  buildEnvironment: () => ({}),
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
  isShellToolName: () => false,
};
export function antigravityProvider(options: Omit<AntigravityAcpProviderOptions, "host"> = {}) {
  return new AntigravityAcpProvider({ ...options, host: fixtureAntigravityHost });
}
