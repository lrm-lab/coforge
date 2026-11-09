import { getLogger } from "@logtape/logtape";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import {
  describeRecycledSession,
  type ColdIdleStop,
} from "#src/agent-runtime/wake-session-recycle";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { logStalledRuntimeRestart } from "./agent-failure-logs";
import type { StalledRecoveryBasis } from "./stalled-recovery";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Why a live runtime is ended, what is announced, and what is logged on either outcome. */
export type RuntimeReleasePlan = Readonly<{
  announce: Readonly<{ detailKind: string; text: string }>;
  /** Logged once the announcement is out. */
  log: () => void;
  failure: Readonly<{ text: string; message: string; event: string }>;
  /** What happens once the runtime is down. */
  wake: Readonly<{
    /** Wake only an Agent with deliveries or app items kept for its next launch. */
    onlyIfParked: boolean;
    /** The caller waits for the launch, rather than going on while it runs. */
    awaited: boolean;
    /** Logged when the relaunch fails. */
    failure: Readonly<{ message: string; event: string }>;
    /** The relaunch's first turn, when no message waits to be it. */
    resumePrompt?: string;
  }>;
}>;

/** `resumePrompt` is the relaunch's first turn when no message waits for it. */
export function stalledRuntimePlan(
  restart: AgentRestartConfig,
  agentId: string,
  basis: StalledRecoveryBasis,
  resumePrompt?: string,
): RuntimeReleasePlan {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  const unattended = resumePrompt !== undefined;
  return {
    announce: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
      text: unattended
        ? `Restarting stalled ${runtimeName} runtime; no message was waiting`
        : `Restarting stalled ${runtimeName} runtime for queued message`,
    },
    log: () => logStalledRuntimeRestart(agentId, basis, unattended),
    failure: {
      text: `Restarting the stalled ${runtimeName} runtime failed`,
      message: "Agent stalled-runtime restart failed",
      event: "agent.runtime.stalled_recovery_failed",
    },
    wake: {
      onlyIfParked: false,
      awaited: true,
      failure: {
        message: "Agent stalled-runtime relaunch failed",
        event: "agent.runtime.stalled_recovery_failed",
      },
      ...(resumePrompt !== undefined ? { resumePrompt } : {}),
    },
  };
}

export function freshConfigRuntimePlan(restart: AgentRestartConfig): RuntimeReleasePlan {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  return {
    announce: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE,
      text: `Restarting ${runtimeName} runtime: this Workspace's features changed`,
    },
    log: () => logger.info("Agent runtime restarted for changed features"),
    failure: {
      text: `Restarting the ${runtimeName} runtime failed`,
      message: "Agent feature-change restart failed",
      event: "agent.runtime.feature_restart_failed",
    },
    wake: {
      onlyIfParked: false,
      awaited: true,
      failure: {
        message: "Agent feature-change relaunch failed",
        event: "agent.runtime.feature_restart_failed",
      },
    },
  };
}

export function coldIdleRuntimePlan(
  restart: AgentRestartConfig,
  stop: ColdIdleStop,
): RuntimeReleasePlan {
  const runtimeName = runtimeDisplayName(restart.config.provider);
  return {
    announce: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE,
      text: `Stopped idle ${runtimeName} runtime (${describeRecycledSession(stop.idleMs, stop.priorContextTokens)}) to free memory; it restarts on the next message`,
    },
    log: () =>
      logger.info("Agent cold idle runtime stopped", {
        event: "agent.runtime.cold_idle_stop",
        agent_id: stop.agentId,
        session_id: stop.sessionId,
        idle_ms: stop.idleMs,
        prior_context_tokens: stop.priorContextTokens,
      }),
    failure: {
      text: `Stopping the idle ${runtimeName} runtime failed`,
      message: "Agent cold idle stop failed",
      event: "agent.runtime.cold_idle_stop_failed",
    },
    wake: {
      onlyIfParked: true,
      awaited: false,
      failure: {
        message: "Agent cold idle relaunch failed",
        event: "agent.runtime.cold_idle_wake_failed",
      },
    },
  };
}
