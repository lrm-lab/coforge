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
    ...(runtime?.fastMode && claudeModelSupportsFastMode(runtime.model)
      ? ["--settings", JSON.stringify({ fastMode: true })]
      : []),
  ];
}

/** Models whose fast mode a launch must not request (Raft 1.0.63's
 * `RUNTIME_FAST_MODE_UNSUPPORTED_MODELS`): Opus 4.8 dropped it, so a saved fast-mode flag is
 * ignored for it. The `[1m]` context suffix is not part of the model's identity. */
const CLAUDE_FAST_MODE_UNSUPPORTED_MODELS = new Set(["claude-opus-4-8"]);

export function claudeModelSupportsFastMode(model: string | undefined): boolean {
  if (model === undefined) return true;
  return !CLAUDE_FAST_MODE_UNSUPPORTED_MODELS.has(model.replace(/\[1m\]$/, ""));
}

/** Drops `CLAUDECODE`: inherited from a daemon started inside a Claude Code session, it makes the
 * child Claude believe it is nested. Claude-specific; other providers' environments keep it. */
export function withoutClaudeCodeMarker(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const { CLAUDECODE: _marker, ...rest } = environment;
  return rest;
}

/** Env var naming the token count at which Claude Code auto-compacts (model-config docs, "Set the
 * auto-compact window"). Chosen over `--autocompact` because an older CLI rejects an unknown flag
 * but ignores an unknown variable. */
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** Claude Code's own auto-memory writes a second memory store next to the Agent's MEMORY.md
 * files; a headless Agent keeps only the CoForge-injected memory, so the feature stays off
 * (Raft 1.0.63 sets the same variable in its Claude spawn env). */
export const CLAUDE_DISABLE_AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/** Claude Code's exact stderr line when `--dangerously-skip-permissions` meets root/sudo
 * (Raft 1.0.63's `CLAUDE_ROOT_REFUSAL`); matched whole-line only. */
export const CLAUDE_ROOT_REFUSAL =
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

/** Raft's `isClaudeRootRefusal`: exit 1 with the refusal line on stderr, before any turn —
 * in practice always during launch, so the launch fails with this named reason instead of a
 * generic spawn error. Call after the process's stderr has drained (`dispose`). */
export function isClaudeRootRefusal(process: {
  readonly exitCode?: number;
  stderrExcerpt(): string;
}): boolean {
  return (
    process.exitCode === 1 &&
    process
      .stderrExcerpt()
      .split("\n")
      .some((line) => line.trim() === CLAUDE_ROOT_REFUSAL)
  );
}

/** The auto-compact window a long-lived Agent gets unless its `envVars` or the Daemon's own
 * environment set one: a 1M-context model would otherwise compact only near 967k. A plain token
 * count, which every Claude Code version reads (the `k`/`M` suffixes need 2.1.304+). */
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 512_000;

const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;
const UNIT_TOKENS: Readonly<Record<string, number>> = { "": 1, k: 1_000, m: 1_000_000 };

/** The host environment with the default auto-compact window beneath it: passed as
 * `agentEnvironment`'s inherited layer, so a value from the Daemon's own environment or the Agent's
 * `envVars` still wins. */
export function withDefaultAutoCompactWindow(
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: String(DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW),
    ...inherited,
  };
}

/**
 * The auto-compact window, in tokens, Claude Code derives from a `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * value: a plain integer token count, or one with a `k`/`M` suffix, clamped to 100k..1M. A value
 * that is not a usable size is ignored by Claude Code, so it is `undefined` here.
 */
export function parseClaudeAutoCompactWindow(value: string | undefined): number | undefined {
  const match = /^(\d+)([kKmM]?)$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const tokens = Number(match[1]) * UNIT_TOKENS[match[2]!.toLowerCase()]!;
  return Math.min(Math.max(tokens, CLAUDE_AUTO_COMPACT_WINDOW_MIN), CLAUDE_AUTO_COMPACT_WINDOW_MAX);
}
