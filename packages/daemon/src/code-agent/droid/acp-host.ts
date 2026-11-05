import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type DroidAcpRuntimeHost } from "@lrm/coforge-anvil/droid";
import { scrubStderrHint } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DROID]);

export const droidAcpRuntimeHost: DroidAcpRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  stderrHint: (lines) => {
    const hint = lines.map(scrubStderrHint).join("\n").trim();
    if (hint)
      logger.warn("code_agent:stderr", {
        provider: RUNTIME_PROVIDER.DROID,
        stderr_hint: hint,
      });
  },
  catalogCwd: (stateDirectory, fallback) => {
    if (!stateDirectory) return fallback;
    const directory = join(stateDirectory, "droid-catalog-probe");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return directory;
    } catch {
      return fallback;
    }
  },
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment ?? {}, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      provider: options.runtime?.provider,
    }),
  }),
};
