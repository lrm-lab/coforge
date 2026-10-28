import type { CommandCodeRuntimeHost, CommandCodeAuthHost } from "@lrm/coforge-anvil/command-code";
import { agentEnvironment } from "#src/code-agent/environment";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { readVersionOutput } from "#src/code-agent/version-probe";
export const commandCodeRuntimeHost: CommandCodeRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
      extraEnv: { NO_COLOR: "1" },
    }),
    PWD: options.agentWorkspaceDirectory,
  }),
  buildCatalogEnvironment: (environment) =>
    agentEnvironment(undefined, environment, undefined, {
      extraEnv: { NO_COLOR: "1" },
    }),
};
export function createCommandCodeAuthHost(command: readonly string[]): CommandCodeAuthHost {
  return {
    // Human `cmd status` writes "Not authenticated" on stderr. `--json` is the stdout this probe reads.
    runStatus: (cwd, timeoutMs) =>
      runCatalogCommand([...command, "status", "--json"], cwd, Bun.env, timeoutMs),
  };
}
