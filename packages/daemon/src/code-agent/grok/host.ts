import type { GrokRuntimeHost } from "@lrm/coforge-anvil/grok";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { maskEmail } from "#src/code-agent/mask-email";

export const grokRuntimeHost: GrokRuntimeHost = {
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  sessionClientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  catalogClientInfo: { name: "coforge-daemon-catalog", version: "0.1.0" },
  usageClientInfo: { name: "coforge-daemon-usage", version: "0.1.0" },
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  maskAccountLabel: maskEmail,
  buildSessionEnvironment: (options) =>
    agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
      extraEnv: { PWD: options.agentWorkspaceDirectory, NO_COLOR: "1" },
    }),
  buildCatalogEnvironment: (environment) => agentEnvironment(undefined, environment),
  buildUsageEnvironment: (environment) => agentEnvironment(environment),
};
