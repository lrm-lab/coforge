import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { type OpenCodeAcpRuntimeHost } from "@lrm/coforge-anvil/opencode";
import { scrubStderrHint } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.OPENCODE]);

export const openCodeAcpRuntimeHost: OpenCodeAcpRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  stderrHint: (lines) => {
    const hint = lines.map(scrubStderrHint).join("\n").trim();
    if (hint)
      logger.warn("code_agent:stderr", {
        provider: RUNTIME_PROVIDER.OPENCODE,
        stderr_hint: hint,
      });
  },
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  // opencode's ACP server keeps its own environment contract; unlike agy it does not switch
  // token stores on SSH session markers, so the daemon leaves them alone (task #319 decision).
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment ?? {}, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      provider: options.runtime?.provider,
    }),
  }),
};
