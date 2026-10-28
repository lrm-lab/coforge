import type { DevinAuthHost, DevinRuntimeHost } from "@lrm/coforge-anvil/devin";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { agentEnvironment } from "#src/code-agent/environment";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";
import { processSpawner } from "#src/code-agent/process-host";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { COFORGE_DAEMON_VERSION } from "#src/version";

export const devinRuntimeHost: DevinRuntimeHost = {
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

export function createDevinAuthHost(options: {
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}): DevinAuthHost {
  return {
    terminalLoginSupported: (options.platform ?? process.platform) !== "win32",
    spawn(args, cwd, terminal) {
      const env = agentEnvironment(undefined, Bun.env, options.platform, {
        extraEnv: { NO_COLOR: "1", TERM: "xterm-256color" },
      });
      const executable =
        resolveHostCodeAgentExecutable(
          RUNTIME_PROVIDER.DEVIN,
          options.environment,
          options.platform,
        ) ?? RUNTIME_PROVIDER.DEVIN;
      return runtimeAuthProcess(
        processSpawner.spawn([executable, ...args], cwd, env, { terminal }),
      );
    },
  };
}
