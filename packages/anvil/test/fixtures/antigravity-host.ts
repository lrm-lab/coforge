import {
  AntigravityProvider,
  type AntigravityRuntimeHost,
  type AntigravityProviderOptions,
} from "@lrm/coforge-anvil";
import { fixturePerTurnHost, fixtureVersionReader, fixtureCatalogCommand } from "./runtime-host";
export const fixtureAntigravityHost: AntigravityRuntimeHost = {
  sessionHost: fixturePerTurnHost,
  versionReader: fixtureVersionReader,
  catalogCommandRunner: fixtureCatalogCommand,
  readUsageEnvironment: () => ({}),
};
export function antigravityProvider(options: Omit<AntigravityProviderOptions, "host"> = {}) {
  return new AntigravityProvider({ ...options, host: fixtureAntigravityHost });
}
