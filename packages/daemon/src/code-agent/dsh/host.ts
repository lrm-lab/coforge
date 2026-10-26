import { createDshLaunchContents, type DshRuntimeHost } from "@lrm/coforge-anvil/dsh";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { prepareDshLaunchFiles } from "./launch-files";

export const dshRuntimeHost: DshRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readVersionOutput,
  prepareLaunch: (instructions) => prepareDshLaunchFiles(instructions, createDshLaunchContents),
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
      extraEnv: { PWD: options.agentWorkspaceDirectory, NO_COLOR: "1" },
    }),
    // Same autonomous Computer policy as Codex; never put credentials in argv or patch data.
    DSH_PERMISSION_MODE: "danger-full-access",
  }),
};
