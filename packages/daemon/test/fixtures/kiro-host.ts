import { KiroProvider, type KiroProviderOptions } from "@lrm/coforge-anvil";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";

export function kiroProvider(options: Omit<KiroProviderOptions, "host"> = {}) {
  return new KiroProvider({ ...options, host: kiroRuntimeHost });
}
