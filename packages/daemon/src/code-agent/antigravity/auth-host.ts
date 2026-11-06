import type { AntigravityAuthHost } from "@lrm/coforge-anvil/antigravity";
import { withoutSshSessionVariables } from "@lrm/coforge-anvil/antigravity";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentEnvironment } from "#src/code-agent/environment";
import { maskEmail } from "#src/code-agent/mask-email";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";

/** Whether this Computer can open a browser for the `authenticate` OAuth flow — a real desktop
 * session, not a headless remote or a cloud workspace. macOS and Windows always can; Linux and
 * cloud computers need a display. */
export function canOpenBrowser(platform: NodeJS.Platform = process.platform): boolean {
  if (process.env.COFORGE_COMPUTER_CLOUD === "1") return false;
  if (platform === "linux") return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

export function createAntigravityAuthHost(options: {
  command: readonly string[];
  platform?: NodeJS.Platform;
  stateDirectory?: string;
}): AntigravityAuthHost {
  return {
    command: options.command,
    // agy switches token stores when SSH session markers reach it — the auth process gets the
    // same stripped environment the session does.
    environment: agentEnvironment(
      withoutSshSessionVariables({}),
      withoutSshSessionVariables(Bun.env),
      undefined,
      { envVars: undefined, provider: RUNTIME_PROVIDER.ANTIGRAVITY },
    ),
    processTreeSpawner: processSpawner,
    clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
    canOpenBrowser: canOpenBrowser(options.platform),
    stateDirectory: options.stateDirectory ?? join(homedir(), ".coforge", "daemon"),
    maskAccountLabel: maskEmail,
  };
}
