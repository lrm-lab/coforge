import type {
  AgentStartIntent,
  AgentSessionReport,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { SessionReference } from "./launch-identity";

/** The rebind path's reach into the runtime: the launch and session-identity records it
 * re-points in place, the process manager, and the two reports it re-issues under the new scope. */
export type AgentRebindPorts = Readonly<{
  currentActivityLaunches: Map<string, ActivityLaunch>;
  sessionReferences: Map<string, SessionReference>;
  agentProcessManager: AgentProcessManager;
  runtimeInstanceId: string;
  envelope(): Pick<
    AgentSessionReport,
    "workspaceId" | "computerId" | "protocolMajor" | "requestId"
  >;
  reportAgentSession(report: AgentSessionReport): Promise<void>;
  sendAgentStatus(agentId: string, status: "active" | "inactive"): void;
}>;

/**
 * Rebinds the agent's already-running process to a newer control scope:
 * `AgentControl.start()`'s single seam for "a Start met a process that is already running
 * under an older, terminal operation." Never spawns or stops anything, never requests a new
 * launch config/credential (the running process's Agent API key and local proxy token are
 * kept) — it only re-points every place the runtime remembers this launch's identity so a
 * later daemon->server message about this process carries the new scope, then immediately
 * re-reports the Session and `agent:status(active)` under it. Returns the running process's
 * current Session identity, exactly like `#launchAgent` returns one for a fresh launch, so
 * `AgentControl.start()` can report it in the rebind's `started` result.
 *
 * Every closure/map this mutates is mutated IN PLACE (`activityLaunch.launchId = launchId`,
 * not a new `ActivityLaunch` object) rather than replaced, so the `#launchAgent` closures that
 * already hold a reference to it — the process-exit handler's `#agentControl.stopped(agentId,
 * launch.launchId, ...)`, `AgentActivityPublisher`'s `launch.launchId`/`launch.clientSeq`
 * and its last-busy `{ launch, ... }` identity comparisons — see the update for free,
 * without restructuring each one individually or losing the exit handler's
 * `#currentActivityLaunches.get(agentId) === launch` identity check (a *replacement* object
 * there would silently turn that handler into a no-op for the rebound launch).
 */
export async function rebindAgent(
  ports: AgentRebindPorts,
  intent: AgentStartIntent,
  launchId: string,
): Promise<SessionIdentity | undefined> {
  const agentId = intent.agentId;
  const activityLaunch = ports.currentActivityLaunches.get(agentId);
  const reference = ports.sessionReferences.get(agentId);
  const previousLaunchId = activityLaunch?.launchId ?? reference?.launchId;
  if (activityLaunch) {
    activityLaunch.launchId = launchId;
    // The server's Activity idempotency key is (agentId, launchId, clientSeq)
    // (docs/observability/activity-delivery-and-errors.md); restarting it at the daemon's normal initial value under a NEW
    // launchId is exactly what a fresh launch already does and stays disjoint from every
    // clientSeq already sent under the previous launchId.
    activityLaunch.clientSeq = 0;
  }
  // Rebind moves this Agent to a genuinely new server launch identity — remember it
  // (a later wake must reuse THIS one, not the one being replaced) and reset the survived
  // clientSeq counter in lockstep with `activityLaunch.clientSeq` above.
  ports.agentProcessManager.rememberServerLaunch(agentId, {
    requestId: intent.requestId,
    controlEpoch: intent.controlEpoch ?? 0,
    launchId,
  });
  ports.agentProcessManager.recordClientSeq(agentId, 0);
  if (reference) {
    reference.requestId = intent.requestId;
    reference.controlEpoch = intent.controlEpoch;
    reference.launchId = launchId;
  }
  const session = ports.agentProcessManager.session(agentId);
  const identity = await session?.readSessionIdentity?.();
  // A rebind sends `agent:session` as a direct, fire-and-forget report (like
  // `#launchAgent`'s own closure), not through `AgentSessions.capture`/`replay` (which would
  // re-enter `state.run` for this agentId and deadlock: `AgentControl.start()` is already
  // running inside that same per-agent mutex). `previousLaunchId` carries the launch being
  // replaced so `AgentSessions.verify` on the server can accept the hand-over even if it does
  // not yet trust the new `launchId` alone.
  if (identity?.sessionId) {
    try {
      await ports.reportAgentSession({
        ...ports.envelope(),
        agentId,
        provider: intent.provider,
        sessionId: identity.sessionId,
        startRequestId: intent.requestId,
        daemonInstanceId: ports.runtimeInstanceId,
        launchId,
        ...(previousLaunchId ? { previousLaunchId } : {}),
        ...(intent.controlEpoch !== undefined ? { controlEpoch: intent.controlEpoch } : {}),
      });
    } catch {
      // `reportAgentSession` already logs `agent_session:report_failed` at error level; a
      // failed immediate re-report is not fatal here — the persisted `record.report`
      // (`AgentSessions.capture`, in `AgentControl.start()`) is still replayed on the next
      // ready/reconnect pass.
    }
  }
  ports.sendAgentStatus(agentId, "active");
  return identity;
}
