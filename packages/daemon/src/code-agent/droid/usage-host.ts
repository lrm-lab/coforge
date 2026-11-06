import {
  DROID_USAGE_SCREEN,
  type DroidAuthProcess,
  type DroidUsageHost,
} from "@lrm/coforge-anvil/droid";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DROID]);

/** Host spawn for Droid's plan-usage scan: the interactive TUI in a wide PTY, the same
 * environment and resolved executable the ACP session and auth flows use. The anvil reader
 * owns every screen decision; this side only owns the process. */
export function createDroidUsageHost(options: { platform?: NodeJS.Platform } = {}): DroidUsageHost {
  const platform = options.platform ?? process.platform;
  const environment = agentEnvironment(undefined, Bun.env, undefined, {
    envVars: undefined,
    provider: RUNTIME_PROVIDER.DROID,
  });
  const command = [
    resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.DROID, environment, platform) ??
      RUNTIME_PROVIDER.DROID,
  ];
  return {
    spawn: (workingDirectory): DroidAuthProcess =>
      runtimeAuthProcess(
        processSpawner.spawn(command, workingDirectory, environment, {
          terminal: true,
          terminalSize: DROID_USAGE_SCREEN,
        }),
      ),
    logFailure: (reason) =>
      logger.warn("code_agent:droid_usage", {
        provider: RUNTIME_PROVIDER.DROID,
        reason,
      }),
  };
}
