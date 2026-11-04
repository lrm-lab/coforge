import { UNATTENDED_RECOVERY_LIMIT } from "./stalled-recovery";
import type { UnattendedRecoveryAdmission } from "./stalled-recovery";

import {
  AGENT_ACTIVITY_DETAIL_KIND,
  STALLED_RESTART_LIMIT_ERROR,
  type AgentActivityRuntimeError,
} from "@lrm/coforge-sdk/internal";
import { fingerprintRuntimeError } from "#src/agent-runtime/runtime-error-activity";
import { getLogger } from "@logtape/logtape";
import { runtimeDisplayName } from "./session-invalidate-activity";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type UnattendedRun = { count: number; lastAtMs: number; reportedFor?: object };

/**
 * The run of unattended restarts per Agent. A turn that completes after the last restart ends
 * the run (the relaunch's own progress says so), so the next stall starts a new one. Past the
 * limit nothing here relaunches the Agent, so a different launch than the one reported on was
 * started by someone else (a message, a person): it starts a new run too.
 */
export class UnattendedRecoveries {
  readonly #runs = new Map<string, UnattendedRun>();

  /** `launch` is the stalled launch's identity, compared only by reference. */
  admit(
    agentId: string,
    launch: object,
    lastCompletedAtMs: number | undefined,
    nowMs = Date.now(),
  ): UnattendedRecoveryAdmission {
    let run = this.#runs.get(agentId);
    if (run && lastCompletedAtMs !== undefined && lastCompletedAtMs > run.lastAtMs) run = undefined;
    if (run?.reportedFor && run.reportedFor !== launch) run = undefined;
    run ??= { count: 0, lastAtMs: 0 };
    this.#runs.set(agentId, run);
    if (run.count >= UNATTENDED_RECOVERY_LIMIT) {
      if (run.reportedFor) return "held";
      run.reportedFor = launch;
      return "limit";
    }
    run.count += 1;
    run.lastAtMs = nowMs;
    return "restart";
  }
}

/** The Agent stalled again after the last unattended restart allowed: its owner sees why, as
 * an error, and nothing restarts it until a message arrives or someone does. A stall, not a
 * turn-ending kind: the turn is still live and hung, so a message must still read it as stalled
 * and restart it. */
export function reportUnattendedLimit<L>(
  publish: (
    agentId: string,
    launch: L,
    detailKind: string,
    level: "info" | "error",
    text: string,
    extra?: Readonly<{ runtimeError?: AgentActivityRuntimeError }>,
  ) => void,
  agentId: string,
  launch: L,
  restart: AgentRestartConfig,
): void {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  const text = `The ${runtimeName} runtime stalled again after ${UNATTENDED_RECOVERY_LIMIT} automatic restarts with no message waiting. It is not restarted again until a message arrives or someone restarts it.`;
  // The reason the profile shows while the process lives (`failureReason`, task #418).
  publish(agentId, launch, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED, "error", text, {
    runtimeError: {
      ...STALLED_RESTART_LIMIT_ERROR,
      fingerprint: fingerprintRuntimeError(text),
    },
  });
  logger.warn("Agent runtime stalled past its unattended restart limit", {
    event: "agent.runtime.stalled_recovery_limit",
    agent_id: agentId,
    limit: UNATTENDED_RECOVERY_LIMIT,
  });
}
