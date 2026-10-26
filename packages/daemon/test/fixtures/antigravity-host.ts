import {
  AntigravityProvider,
  type AntigravityProviderOptions,
} from "@lrm/coforge-anvil/antigravity";
import { antigravityRuntimeHost } from "#src/code-agent/antigravity/host";
export function antigravityProvider(options: Omit<AntigravityProviderOptions, "host"> = {}) {
  return new AntigravityProvider({ ...options, host: antigravityRuntimeHost });
}
