import {
  withoutSshSessionVariables,
  type AntigravityAcpRuntimeHost,
} from "@lrm/coforge-anvil/antigravity";
import { scrubStderrHint } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

const logger = getLogger(["coforge", "daemon", "code-agent", "antigravity"]);

export const antigravityAcpRuntimeHost: AntigravityAcpRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  catalogCommandRunner: runCatalogCommand,
  readUsageEnvironment: () => Bun.env,
  stderrHint: (lines) => {
    const hint = lines.map(scrubStderrHint).join("\n").trim();
    if (hint)
      logger.warn("code_agent:stderr", {
        provider: "antigravity",
        stderr_hint: hint,
      });
  },
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  // agy switches token stores when SSH session markers reach it, so a Daemon started over SSH
  // must not inherit them; an explicit Agent override still applies on top.
  buildEnvironment: (options) => ({
    ...agentEnvironment(
      withoutSshSessionVariables(options.environment ?? {}),
      withoutSshSessionVariables(Bun.env),
      undefined,
      {
        envVars: options.runtime?.envVars,
        provider: options.runtime?.provider,
      },
    ),
  }),
};
