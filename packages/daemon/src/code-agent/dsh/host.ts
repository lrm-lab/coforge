import { createDshLaunchContents, type DshRuntimeHost } from "@lrm/coforge-anvil/dsh";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { readDshVersionOutput } from "./version-probe";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { prepareDshLaunchFiles } from "./launch-files";

export const dshRuntimeHost: DshRuntimeHost = {
  clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
  processTreeSpawner: processSpawner,
  versionReader: readDshVersionOutput,
  prepareLaunch: (instructions) => prepareDshLaunchFiles(instructions, createDshLaunchContents),
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildEnvironment: (options) => ({
    ...agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      gitHooks: options.gitHooks,
      extraEnv: { NO_COLOR: "1" },
    }),
    // The host owns the real cwd. A declared/inherited PWD must not override it, including
    // when catalog discovery composes this environment again for its temporary directory.
    PWD: options.agentWorkspaceDirectory,
    // Same autonomous Computer policy as Codex; never put credentials in argv or patch data.
    DSH_PERMISSION_MODE: "danger-full-access",
  }),
};
