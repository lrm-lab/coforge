import type { AgentSessionOptions } from "@coforge/agent";
import { stat } from "node:fs/promises";
import {
  withoutClaudeCodeMarker,
  withDefaultAutoCompactWindow,
  parseClaudeAutoCompactWindow,
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  type ClaudeRuntimeHost,
} from "@lrm/coforge-anvil/claude-code";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { ProcessTreeOwner } from "#src/platform/process-tree";
import { maskEmail } from "#src/code-agent/mask-email";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";
import { claudeCliEnvironment, runClaudeCli } from "./process";
import { createPromptFile } from "./prompt-file";
import { claudeHistoryHost } from "./history-host";

/** A Claude Code Agent's child environment, and the auto-compact window it sets, if usable. */
function claudeLaunchEnvironment(
  options: Pick<AgentSessionOptions, "environment" | "runtime" | "gitHooks">,
): { environment: Record<string, string>; autoCompactWindow: number | undefined } {
  const environment = withoutClaudeCodeMarker(
    agentEnvironment(options.environment, withDefaultAutoCompactWindow(Bun.env), undefined, {
      envVars: options.runtime?.envVars,
      provider: options.runtime?.provider,
      gitHooks: options.gitHooks,
    }),
  );
  return {
    environment,
    autoCompactWindow: parseClaudeAutoCompactWindow(environment[CLAUDE_AUTO_COMPACT_WINDOW_ENV]),
  };
}

const capabilityCache = new Map<string, boolean>();

async function withUsageCapabilityCache(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  load: (remember: (supported: boolean) => void) => Promise<boolean>,
): Promise<boolean> {
  const executable = command[0]
    ? Bun.which(command[0], { cwd, PATH: environment.PATH ?? "" })
    : null;
  const build = executable ? await stat(executable).catch(() => undefined) : undefined;
  const key = build
    ? `${command.join("\0")}\0${executable}\0${build.mtimeMs}\0${build.size}`
    : undefined;
  const cached = key ? capabilityCache.get(key) : undefined;
  if (cached !== undefined) return cached;
  return load((supported) => {
    if (key) capabilityCache.set(key, supported);
  });
}

export const claudeRuntimeHost: ClaudeRuntimeHost = {
  ...claudeHistoryHost,
  processTreeSpawner: processSpawner,
  buildSessionEnvironment: claudeLaunchEnvironment,
  createPromptFile,
  createReplyIntentScanner: () => new ReplyIntentScanner(),
  isShellToolName,
  buildUsageEnvironment: claudeCliEnvironment,
  runCli: runClaudeCli,
  spawnUsageProcess: (command, cwd, environment) =>
    new ProcessTreeOwner().spawn(command, cwd, environment),
  withUsageCapabilityCache,
  maskAccountLabel: maskEmail,
};
