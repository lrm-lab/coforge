import type { AgentSessionOptions } from "@coforge/agent";

/**
 * Claude tools a headless Agent must not use: plan mode waits for a human approval no one can give,
 * and Claude's own wakeup/cron scheduling lives only as long as the process and bypasses CoForge's
 * reminders. Passed as one comma-joined `--disallowed-tools` argument.
 */
export const CLAUDE_DISALLOWED_TOOLS = [
  "EnterPlanMode",
  "ExitPlanMode",
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
] as const;

/** The full argv of one long-lived Claude Code Agent launch: fresh (`createSessionId`) or resumed. */
export function claudeLaunchCommand(
  base: readonly string[],
  launch: {
    promptPath: string;
    runtime?: AgentSessionOptions["runtime"];
    resumeSessionId?: string;
    createSessionId?: string;
  },
): string[] {
  const { runtime } = launch;
  return [
    ...base,
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--disallowed-tools",
    CLAUDE_DISALLOWED_TOOLS.join(","),
    ...(launch.resumeSessionId ? ["--resume", launch.resumeSessionId] : []),
    ...(launch.createSessionId ? ["--session-id", launch.createSessionId] : []),
    "--append-system-prompt-file",
    launch.promptPath,
    ...(runtime?.model ? ["--model", runtime.model] : []),
    ...(runtime?.reasoning ? ["--effort", runtime.reasoning] : []),
    ...(runtime?.fastMode ? ["--settings", JSON.stringify({ fastMode: true })] : []),
  ];
}

/** Drops `CLAUDECODE`: inherited from a daemon started inside a Claude Code session, it makes the
 * child Claude believe it is nested. Claude-specific; other providers' environments keep it. */
export function withoutClaudeCodeMarker(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const { CLAUDECODE: _marker, ...rest } = environment;
  return rest;
}
