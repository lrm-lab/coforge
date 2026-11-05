import type { DroidAuthHost, DroidAuthProcess } from "@lrm/coforge-anvil/droid";
import { RUNTIME_PROVIDER, redactCredentials } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { maskEmail } from "#src/code-agent/mask-email";
import { processSpawner } from "#src/code-agent/process-host";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { COFORGE_DAEMON_VERSION } from "#src/version";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DROID]);

/** A PTY-backed TUI login is verified on macOS and Linux; elsewhere the page falls back to the
 * terminal instructions. */
export function droidInteractiveLoginSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** Host process, environment and masking policy for Droid's own auth adapter. */
export function createDroidAuthHost(options: { platform?: NodeJS.Platform } = {}): DroidAuthHost {
  const platform = options.platform ?? process.platform;
  const environment = agentEnvironment(undefined, Bun.env, undefined, {
    envVars: undefined,
    provider: RUNTIME_PROVIDER.DROID,
  });
  const command = [
    resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.DROID, environment, platform) ??
      RUNTIME_PROVIDER.DROID,
  ];
  const spawn = (args: readonly string[], cwd: string, terminal: boolean): DroidAuthProcess =>
    runtimeAuthProcess(processSpawner.spawn([...command, ...args], cwd, environment, { terminal }));
  return {
    command,
    environment,
    processTreeSpawner: processSpawner,
    clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
    interactiveLoginSupported: droidInteractiveLoginSupported(platform),
    factoryApiKeyConfigured: Boolean(environment.FACTORY_API_KEY?.trim()),
    spawn,
    maskAccountLabel: maskEmail,
    logUnmatchedLoginOutput: (text) =>
      logger.warn("code_agent:droid_login_output", {
        provider: RUNTIME_PROVIDER.DROID,
        outcome: "no_device_code",
        output: redactCredentials(text).slice(-4_000),
      }),
  };
}
