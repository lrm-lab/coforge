import { join } from "node:path";
import {
  GrokProvider,
  type GrokProviderOptions,
  readGrokVersion as readVersion,
} from "@lrm/coforge-anvil/grok";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
export function grokProvider(options: Omit<GrokProviderOptions, "host"> = {}) {
  return new GrokProvider({ ...options, host: grokRuntimeHost });
}

export const readGrokVersion = (command: readonly string[]) =>
  readVersion(command, grokRuntimeHost.versionReader);

/** The inherited environment with Grok confined to `home`: fixture credentials, no ambient Grok
 * config, and no proxy between the CLI and the local model endpoint. */
export function isolatedEnvironment(home: string) {
  return {
    ...Bun.env,
    GROK_HOME: home,
    GROK_AUTH_PATH: join(home, "auth.json"),
    XAI_API_KEY: "fixture-only",
    GROK_CONFIG: "",
    GROK_CONFIG_PATH: "",
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
  };
}
