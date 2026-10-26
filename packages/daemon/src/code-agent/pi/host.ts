import type { PiRuntimeHost } from "@lrm/coforge-anvil";
import { getAgentDir } from "@coforge/agent";
import { agentEnvironment } from "#src/code-agent/environment";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

export const piRuntimeHost: PiRuntimeHost = {
  getDefaultAgentDirectory: getAgentDir,
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildSessionEnvironment: (options) =>
    agentEnvironment(options.environment, Bun.env, process.platform, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
    }),
};
