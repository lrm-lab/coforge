import type { AgentActivity, AgentSessionExit } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import {
  isZeroEvidenceReason,
  RUNTIME_ERROR_FENCE_EXEMPT_CLASSES,
} from "#src/agent-runtime/runtime-error-recovery";
import {
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-vocabulary";
import { getLogger } from "@logtape/logtape";
import type { AgentLifecycleListener } from "./agent-lifecycle";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export const EXIT_STREAK_CAP = 5;

export type ExitFacts = Readonly<{
  crash: RuntimeErrorEvent | undefined;
  exit: AgentSessionExit | undefined;
}>;

export function isUncleanExit({ crash, exit }: ExitFacts): boolean {
  if (crash) {
    const classification = classifyRuntimeError(crash);
    return (
      !RUNTIME_ERROR_FENCE_EXEMPT_CLASSES.has(classification.errorClass) &&
      !isZeroEvidenceReason(classification.errorReason)
    );
  }
  if (!exit) return false;
  return (
    (exit.signal !== null && exit.signal !== undefined) ||
    (typeof exit.code === "number" && exit.code !== 0)
  );
}

export class ExitStreak implements AgentLifecycleListener {
  readonly #counts = new Map<string, number>();

  note(agentId: string): number {
    const count = (this.#counts.get(agentId) ?? 0) + 1;
    this.#counts.set(agentId, count);
    return count;
  }

  clear(agentId: string): void {
    const attempts = this.#counts.get(agentId);
    if (attempts === undefined) return;
    this.#counts.delete(agentId);
    logger.info("Agent exit streak reset", {
      event: "daemon.agent.runtime_error_process_restart.reset",
      agent_id: agentId,
      attempts,
    });
  }

  stopped(agentId: string): void {
    this.clear(agentId);
  }
}

export function buildExitStreakActivity(attempts: number): AgentActivity {
  const detail = `The runtime exited ${attempts} times in a row without producing any output, so CoForge stopped restarting it. Restart the Agent to try again.`;
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    level: "error",
    detail,
    observedAtMs: Date.now(),
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: {
      errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
      errorReason: "runtime_error_fenced",
      fingerprint: fingerprintRuntimeError(detail),
    },
  };
}
