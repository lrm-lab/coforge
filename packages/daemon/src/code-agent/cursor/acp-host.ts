import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { type CursorAcpRuntimeHost } from "@lrm/coforge-anvil/cursor";
import { scrubStderrHint } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CURSOR]);

export const cursorAcpRuntimeHost: CursorAcpRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  stderrHint: (lines) => {
    const hint = lines.map(scrubStderrHint).join("\n").trim();
    if (hint)
      logger.warn("code_agent:stderr", {
        provider: RUNTIME_PROVIDER.CURSOR,
        stderr_hint: hint,
      });
  },
  warnModelFallback: (model) =>
    logger.warn("code_agent:cursor_model_fallback", {
      provider: RUNTIME_PROVIDER.CURSOR,
      model,
    }),
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment ?? {}, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      provider: options.runtime?.provider,
    }),
  }),
};
