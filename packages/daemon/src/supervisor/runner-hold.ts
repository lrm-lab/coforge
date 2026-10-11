import { getLogger } from "@logtape/logtape";
import type {
  DaemonHoldResponse,
  HeldBusyAgent,
  RunnerHoldReason,
} from "@lrm/coforge-sdk/internal";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

/**
 * How long a lifecycle operation lets in-flight Agent work finish after the runner hold is
 * engaged. Past this bound the operation stops the daemon regardless: an Agent that will not
 * finish must not be able to pin a machine on an old version, or to block a restart. Without the
 * hold the effective grace period is the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`.
 */
export const RUNNER_HOLD_MS = 30_000;

const logger = getLogger(["coforge", "daemon", "supervisor"]);

/** How often the hold is re-asked for the busy set. `daemon:hold` is idempotent, so a poll is
 * simply a repeat call; 250ms keeps the common "already idle" case effectively instant. */
export const RUNNER_HOLD_POLL_MS = 250;

/**
 * Settles with `answer`, or rejects with `message` once `timeoutMs` passes. The timer is always
 * cleared: racing against a bare `Bun.sleep` leaves the losing sleep pending, which keeps the
 * event loop - and so the process - alive for the full timeout after the caller has moved on. An
 * restart's last hold lands just before the stop, so that pending sleep made the Coordinator
 * outlive its own shutdown by exactly launchd's 5 s SIGKILL window.
 */
export async function answeredWithin<T>(
  answer: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long the Coordinator waits for one Workspace daemon to answer a runner hold. A Workspace
 * that does not answer is reported unreachable and counted as idle: a wedged or dead Workspace
 * daemon must never be able to block a Computer upgrade or a restart.
 */
export const RUNNER_HOLD_WORKSPACE_TIMEOUT_MS = 5_000;

export type WorkspaceRunnerHoldRequest = {
  workspaceId: string;
  operation: "hold" | "release";
  reason: RunnerHoldReason | undefined;
  eventPrefix: string;
  /** Asks the Workspace daemon over its local socket. */
  hold: (
    operation: "hold" | "release",
    reason: RunnerHoldReason | undefined,
  ) => Promise<DaemonHoldResponse>;
  timeoutMs?: number;
};

/**
 * Asks one Workspace daemon to hold (or release) its runners. A Workspace that does not answer
 * inside `RUNNER_HOLD_WORKSPACE_TIMEOUT_MS`, answers `accepted: false`, or fails outright is
 * reported unreachable and counted as idle: a wedged or dead Workspace daemon must never be
 * able to block a Computer upgrade or a restart. Shared by the Coordinator-wide fan-out and by
 * the per-Workspace restart hold.
 */
export async function askWorkspaceRunnerHold({
  workspaceId,
  operation,
  reason,
  eventPrefix,
  hold,
  timeoutMs = RUNNER_HOLD_WORKSPACE_TIMEOUT_MS,
}: WorkspaceRunnerHoldRequest): Promise<{
  held: boolean;
  busyAgents: HeldBusyAgent[];
  // Optional on the wire report but always known here, so the restart hold can read it without
  // a fallback.
  unreachableWorkspaceIds: string[];
}> {
  const held = operation === "hold";
  try {
    const response = await answeredWithin(
      hold(operation, reason),
      timeoutMs,
      `Workspace ${workspaceId} did not answer the runner hold`,
    );
    if (!response.accepted) return { held, busyAgents: [], unreachableWorkspaceIds: [workspaceId] };
    return {
      held,
      busyAgents: response.busyAgents.map((agent) => ({
        ...agent,
        workspaceId: agent.workspaceId || workspaceId,
      })),
      unreachableWorkspaceIds: [],
    };
  } catch (error) {
    logger.warn("Workspace daemon did not answer the runner hold; treating as idle", {
      event: `${eventPrefix}:runner_hold_unreachable`,
      workspace_id: workspaceId,
      operation,
      timeout_ms: timeoutMs,
      error_message: thrownMessage(error),
    });
    return { held, busyAgents: [], unreachableWorkspaceIds: [workspaceId] };
  }
}

export type RunnerHoldSnapshot = {
  busyAgents: readonly HeldBusyAgent[];
  unreachableWorkspaceIds: readonly string[];
};

export type RunnerHoldOutcome = RunnerHoldSnapshot & {
  /** True when every Agent reached an idle/terminal Activity before the bound elapsed. */
  quiescent: boolean;
  elapsedMs: number;
};

export type RunnerHoldOptions = {
  /** Engages the hold and reports the current busy set. Must be idempotent. */
  hold: () => Promise<RunnerHoldSnapshot>;
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Ends the wait early, not quiescent, once aborted: the operation that asked was taken over. */
  signal?: AbortSignal;
  /** Called once per Agent still busy at the deadline; defaults to a structured log line. */
  onDeadline?: (entry: Record<string, unknown>) => void;
};

/**
 * Holds every runner under a daemon and waits, up to `holdMs`, for its Agents to go idle.
 *
 * Every failure mode resolves towards "proceed": a hold that cannot be asked, or that starts
 * failing mid-poll, returns quiescent, and Workspaces the Coordinator reported unreachable are
 * counted as idle. The hold is a courtesy to in-flight tool calls, never a gate on the operation
 * that asked for it.
 */
export async function holdRunnersUntilQuiescent(
  options: RunnerHoldOptions,
): Promise<RunnerHoldOutcome> {
  const {
    hold,
    holdMs = RUNNER_HOLD_MS,
    pollMs = RUNNER_HOLD_POLL_MS,
    now = Date.now,
    sleep = Bun.sleep,
    onDeadline = (entry) =>
      logger.warn("Agent was still busy when the runner hold expired; stopping anyway", entry),
  } = options;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  let snapshot: RunnerHoldSnapshot = { busyAgents: [], unreachableWorkspaceIds: [] };

  while (true) {
    try {
      snapshot = await hold();
    } catch (error) {
      logger.warn("Runner hold could not be applied; continuing without it", {
        event: "restart:runner_hold_failed",
        elapsed_ms: elapsed(),
        error_message: thrownMessage(error),
      });
      return { ...snapshot, busyAgents: [], quiescent: true, elapsedMs: elapsed() };
    }
    if (snapshot.busyAgents.length === 0)
      return { ...snapshot, quiescent: true, elapsedMs: elapsed() };
    if (options.signal?.aborted) return { ...snapshot, quiescent: false, elapsedMs: elapsed() };
    if (elapsed() >= holdMs) break;
    await sleep(pollMs);
  }

  for (const agent of snapshot.busyAgents)
    onDeadline({
      event: "restart:runner_hold_deadline",
      workspace_id: agent.workspaceId,
      agent_id: agent.agentId,
      detail_kind: agent.detailKind,
      elapsed_ms: elapsed(),
    });
  return { ...snapshot, quiescent: false, elapsedMs: elapsed() };
}
