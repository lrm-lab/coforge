import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { waitsOnProvider } from "./agent-delivery-gate";
import type { ReleasableLaunch, RuntimeReleasePorts } from "./runtime-release";
import { stalledRecoveryBasis, type StalledRecoveryBasis } from "./stalled-recovery";

/** A launch found stalled, and what its restart needs. */
export type StalledRuntime<L extends ReleasableLaunch> = Readonly<{
  launch: L;
  session: AgentSession;
  restart: AgentRestartConfig;
  /** Why it was judged stalled, and on which facts (`stalled-recovery.ts`). */
  basis: StalledRecoveryBasis;
}>;

/**
 * What a stalled-provider restart works on, when a message arriving now should restart this
 * Agent's provider (`stalled-recovery.ts`): its busy turn has been silent too long with nothing
 * still running. The judgment reads only what the runtime and the delivery gate hold, so it lives
 * beside `RuntimeRelease` rather than inside it.
 */
export function stalledRuntime<L extends ReleasableLaunch>(
  ports: RuntimeReleasePorts<L>,
  agentId: string,
): StalledRuntime<L> | undefined {
  const launch = ports.launch(agentId);
  const session = ports.runtime(agentId)?.session;
  const restart = ports.restartConfig(agentId);
  const progress = launch?.progress;
  if (!launch || !progress || !session || !restart) return undefined;
  const basis = stalledRecoveryBasis(
    {
      turnBusy: ports.lastBusy(agentId)?.launch === launch && session.hasLiveTurn !== false,
      // A waiting delivery whose submitted turn never began reports no live turn: that is the
      // "queued but no new round started" case, not a turn to wait on.
      liveTurn: session.hasLiveTurn === true,
      silentForMs: progress.silentForMs(),
      queuedForMs: ports.queuedForMs(agentId),
      hasOpenToolCall: launch.toolCalls?.hasOpenToolCall ?? false,
      resumable: ports.resumable(agentId),
      noticeAcceptedForMs: ageOf(ports.noticeAcceptedAt?.(agentId)),
      // A notice's own write starts an idle Agent's turn (`noteTurnStarted`, `message-composition`),
      // so the two times tell a woken Agent from one whose notice was steered into a turn already
      // running (task #14).
      noticeAcceptedAtMs: ports.noticeAcceptedAt?.(agentId),
      turnStartedAtMs: progress.turnStartedAtMs,
      recoveryHold: waitsOnProvider(ports.explicitHold?.(agentId)),
      // The running session declares whether a notice can steer its live turn; an adapter
      // that does not declare is read as queue-only (the longer fuse).
      steersBusyTurn: session.steersBusyTurn === true,
      lastAgentActionForMs: Math.min(
        progress.silentForMs(),
        ageOf(ports.lastAgentActionAt?.(agentId)) ?? Number.POSITIVE_INFINITY,
      ),
    },
    { lastEventAtMs: progress.lastEventAtMs },
  );
  return basis ? { launch, session, restart, basis } : undefined;
}

function ageOf(atMs: number | undefined): number | undefined {
  return atMs === undefined ? undefined : Date.now() - atMs;
}
