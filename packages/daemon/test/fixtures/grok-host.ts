import {
  GrokProvider,
  type GrokProviderOptions,
  readGrokVersion as readVersion,
} from "@lrm/coforge-anvil";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
export function grokProvider(options: Omit<GrokProviderOptions, "host"> = {}) {
  return new GrokProvider({ ...options, host: grokRuntimeHost });
}

export const readGrokVersion = (command: readonly string[]) =>
  readVersion(command, grokRuntimeHost.versionReader);
