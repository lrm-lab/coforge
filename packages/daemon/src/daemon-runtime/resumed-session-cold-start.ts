import type { AgentSessionInvalidateReason } from "@lrm/coforge-sdk/internal";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import { noteAgentRelaunchPending } from "./agent-launch-tags";
import {
  carriedStart,
  newlyParked,
  type CarriedStart,
  type OwedRecovery,
} from "./provider-replay-recovery";
import type { LaunchRequest } from "./runtime-launch-types";
import { replayRejectedEndPlan } from "./runtime-release-plans";
import { connectionSessionInvalidate } from "./session-invalidate-activity";

/** A stored Session that cannot be continued: invalidate it and cold-start a fresh Session
 * through the ordinary launch gate, so queued deliveries carry over and no later wake can pick
 * the stale Session back up. Two early crashes of a resumed Session within seconds, which the
 * provider cannot report as corrupt (resumed-early-crash.ts; Raft 1.0.63
 * `repeated_early_crash`), and a provider that rejects its replay
 * (provider-replay-recovery.ts) both come here, after the runtime is gone. What a rejected replay
 * `carried` is owed to the Agent's next launch until one has told it. */
export function coldStartResumedSession(
  ports: AgentLaunchCoordinatorPorts,
  owed: OwedRecovery,
  agentId: string,
  launch: ActivityLaunch,
  staleSessionId: string,
  reason: AgentSessionInvalidateReason,
  carried?: CarriedStart,
): void {
  const restart = ports.agentProcessManager.restartConfig(agentId);
  if (!restart || ports.isStopping() || ports.stops.stopping(agentId)) return;
  const reference = ports.sessions.sessionReference(agentId);
  ports.transport().sendSessionInvalidate?.(
    connectionSessionInvalidate(ports.connection, ports.runtimeInstanceId, {
      agentId,
      provider: restart.config.provider,
      sessionId: staleSessionId,
      launchId: reference?.launchId ?? launch.launchId,
      reason,
    }),
  );
  if (reference)
    ports.sessions.rememberSession(agentId, {
      ...reference,
      sessionId: undefined,
      sessionMode: "create",
    });
  ports.agentProcessManager.clearRestartSession(agentId);
  if (carried) owed.owe(agentId, carried);
  // The exit that triggered this cold start must not sweep the strays the relaunch keeps
  // using; the mark clears when the new launch registers its tag token (task #673).
  noteAgentRelaunchPending(agentId);
  ports.relaunchResumed(agentId, restart, {
    sessionMode: "create",
    replacedSessionId: staleSessionId,
    invalidateReason: reason,
  });
}

/** The provider rejected the replay of the stored Session this launch resumed, and the failed
 * turn has ended: end the live runtime through `RuntimeRelease`, then replace the Session as for
 * an early crash. The fresh Session is told what the Agent never read, read before the exit
 * clears it, what arrived while the runtime was ending, and what the launch was started with
 * (provider-replay-recovery.ts), less the tracked mentions the server issues again.
 * Whether the Session was replaced: when not, the watch stays armed for the next rejected turn. */
export async function coldStartRejectedReplay(
  ports: AgentLaunchCoordinatorPorts,
  owed: OwedRecovery,
  agentId: string,
  launch: ActivityLaunch,
  staleSessionId: string,
  started: LaunchRequest,
): Promise<boolean> {
  const restart = ports.agentProcessManager.restartConfig(agentId);
  if (
    !restart ||
    launch.stopping ||
    ports.currentActivityLaunches.get(agentId) !== launch ||
    ports.isStopping() ||
    ports.stops.stopping(agentId)
  )
    return false;
  // Read before the exit clears the attention.
  const unread = ports.messageAttention.check(agentId);
  // A delivery held now is in `unread` too; only those held later are counted from the parking.
  const held = new Set(ports.deliveryGate.pending(agentId).map(({ deliveryId }) => deliveryId));
  return ports.runtimeRelease.endAndReplace(
    agentId,
    replayRejectedEndPlan(restart),
    (parked, carried) => {
      // The failure's backoff belongs to the process that earned it, and its error class (a
      // status code makes it a provider API one) is not one a turn's end lifts: the fresh
      // Session starts with no hold, as after a take-offline.
      ports.deliveryGate.endHoldForNextLaunch(agentId);
      ports.runtimeErrorHold.forget(agentId);
      // The fresh Session was told of none of the items the dead one was told of.
      ports.appInbox.forgetAnnouncedAppItems(agentId);
      coldStartResumedSession(
        ports,
        owed,
        agentId,
        launch,
        staleSessionId,
        "provider_replay_rejected",
        carriedStart(started, unread, newlyParked(parked, held), carried),
      );
    },
  );
}
