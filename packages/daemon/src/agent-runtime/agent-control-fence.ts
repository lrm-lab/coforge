import { getLogger } from "@logtape/logtape";
import type { AgentControlScope } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeRecord } from "./agent-runtime-state";
import type { AgentControlContext } from "./agent-control-runtime";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/** Live phases a repair may rewrite: the record still claims the process is up or mid-transition. */
const LIVE_PHASES = new Set<AgentRuntimeRecord["phase"]>(["running", "starting", "stopping"]);

/**
 * A stale lifecycle fact is a bug in the writer that left it behind, so every repair is logged
 * at error level — it must never become the silent normal path. Repairs only a record whose
 * phase still claims the process is up or mid-transition while the process is confirmed not
 * running: with control records living only in this process (task #54 step 2), the only way a
 * live phase outlives its meaning is a Stop whose failure receipt was never retried (a
 * different-instance writer is impossible here — the memory store dies with its process, and
 * a previous daemon's leftover process is reaped by boot cleanup, task #54 step 1). Leaves
 * everything else (notably "clearing", mid reset-workspace) untouched. Preserves scope,
 * sequence, identity and every prior receipt so idempotency/monotonicity are unaffected; only
 * `phase` moves to "stopped". Call only inside the Agent's `state.run`, as every control
 * transition does.
 */
export async function repairStaleRecord(
  { instanceId, state, runtime }: Pick<AgentControlContext, "instanceId" | "state" | "runtime">,
  agentId: string,
  record: AgentRuntimeRecord | undefined,
): Promise<AgentRuntimeRecord | undefined> {
  if (!record || !LIVE_PHASES.has(record.phase) || runtime.running(agentId)) return record;
  const stuckStopping = record.phase === "stopping" && record.stopResult?.phase === "failed";
  if (!stuckStopping) return record;
  const previousPhase = record.phase;
  const repaired: AgentRuntimeRecord = { ...record, phase: "stopped" };
  await state.store.write(agentId, repaired);
  logger.error("Stale Agent control record repaired", {
    event: "agent_control:stale_record_repaired",
    agent_id: agentId,
    previous_phase: previousPhase,
    daemon_instance_id: instanceId,
    epoch: record.scope.epoch,
  });
  return repaired;
}

export function fence(record: AgentRuntimeRecord | undefined, scope: AgentControlScope) {
  if (!record) return;
  const old = record.scope;
  if (
    old.workspaceId !== scope.workspaceId ||
    old.computerId !== scope.computerId ||
    old.agentId !== scope.agentId ||
    old.epoch > scope.epoch ||
    (old.epoch === scope.epoch && old.provider !== scope.provider)
  )
    throw new Error("stale_control_request");
  // No cross-instance fence: control records live only in this process (task #54 step 2), so
  // every record here was written by this instance. A live process a previous daemon left
  // behind is reaped by boot process cleanup (task #54 step 1) before any operation arrives.
}

export async function requireRecord(record: AgentRuntimeRecord | undefined, known: boolean) {
  // A missing record is the normal state for an Agent this process has not operated on yet
  // (the store is in-memory, task #54 step 2); only an agent this process already tracked
  // losing its record is the invariant violation.
  if (!record && known) throw new Error("control_record_missing");
}

/**
 * Invariant assertions (task #54 step 3): the record's phase and the live process must agree
 * within this process lifetime — a terminal record with a live process, or a running record
 * without one, is a bug in the transition that just wrote them. Logged at error level, never
 * thrown: the assertion watches the boundary, it does not become a second failure path.
 */
export function assertPhaseInvariants(
  { instanceId, runtime }: Pick<AgentControlContext, "instanceId" | "runtime">,
  agentId: string,
  record: AgentRuntimeRecord | undefined,
) {
  if (!record) return;
  const running = runtime.running(agentId);
  const terminal = !LIVE_PHASES.has(record.phase);
  if (terminal === running)
    logger.error("Agent control record phase disagrees with the live process", {
      event: "agent_control:invariant_violation",
      agent_id: agentId,
      phase: record.phase,
      process_running: running,
      daemon_instance_id: instanceId,
    });
}
