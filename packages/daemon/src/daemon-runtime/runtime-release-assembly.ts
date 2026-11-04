import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { daemonIdleFacts } from "./agent-idle-facts";
import type { ActivityDraft, BusyActivity } from "./agent-activity-publisher";
import { RuntimeRelease } from "./runtime-release";
import type {
  ReleasableLaunch,
  RuntimeReleasePorts,
  WakeRestart,
} from "./runtime-release";

/** The `RuntimeRelease` construction `runtime.ts` reads as a call: its ports come from the
 * runtime's collaborators, assembled here so the construction site names them, not their
 * plumbing. `noticeActionClocks` is a thunk — `#messageAttention` is not yet bound when the
 * field initializes. */
export function assembleRuntimeRelease<L extends ReleasableLaunch>(input: {
  launches(): ReadonlyMap<string, L>;
  processManager(): {
    runtime(agentId: string): ReturnType<RuntimeReleasePorts<L>["runtime"]>;
    restartConfig(agentId: string): ReturnType<RuntimeReleasePorts<L>["restartConfig"]>;
    release(agentId: string, timeoutMs: number): Promise<void>;
    isStopping(agentId: string): boolean;
  };
  activityPublisher(): {
    lastBusy(agentId: string): BusyActivity<L> | undefined;
    publish(agentId: string, launch: L, draft: ActivityDraft): void;
  };
  activity: (
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ) => ActivityDraft;
  inputDrain(): {
    get(agentId: string): { items: readonly unknown[]; drain?: unknown } | undefined;
  };
  working(agentId: string): boolean;
  deliveryQueue(): {
    queuedForMs(agentId: string): number | undefined;
    hasQueued(agentId: string): boolean;
    hasHeldAppItems(agentId: string): boolean;
  };
  agentLaunches(): ReadonlyMap<string, unknown>;
  stopState(): {
    sessionId(agentId: string): string | undefined;
    stopping(agentId: string): boolean;
    isStopping(agentId: string): boolean;
  };
  runnerHold(): unknown;
  migrations(): { holds(agentId: string): boolean } | undefined;
  runningMentionIdentity(agentId: string): unknown;
  noticeActionClocks(): {
    noticeAcceptedAt(agentId: string): number | undefined;
    lastAgentActionAt(agentId: string): number | undefined;
  };
  releaseSurvivingHolds(agentId: string): void;
  wakeAgent(agentId: string, restart: WakeRestart): Promise<unknown>;
  mentionDeliveries(): { handBackForRelaunch(agentId: string): Promise<void> };
}): RuntimeRelease<L> {
  return new RuntimeRelease<L>({
    launch: (agentId) => input.launches().get(agentId),
    runtime: (agentId) => input.processManager().runtime(agentId),
    restartConfig: (agentId) => input.processManager().restartConfig(agentId),
    lastBusy: (agentId) => input.activityPublisher().lastBusy(agentId),
    noticeAcceptedAt: (agentId) => input.noticeActionClocks().noticeAcceptedAt(agentId),
    lastAgentActionAt: (agentId) => input.noticeActionClocks().lastAgentActionAt(agentId),
    resumable: (agentId) => input.runningMentionIdentity(agentId) !== undefined,
    sessionId: (agentId) => input.stopState().sessionId(agentId),
    isStopping: (agentId) => input.stopState().stopping(agentId),
    queuedForMs: (agentId) => input.deliveryQueue().queuedForMs(agentId),
    daemonIdleFacts: (agentId) =>
      daemonIdleFacts({
        queue: input.inputDrain().get(agentId),
        working: input.working(agentId),
        deliveriesQueued: input.deliveryQueue().hasQueued(agentId),
        launching: input.agentLaunches().has(agentId),
        stopping:
          input.stopState().isStopping(agentId) || input.processManager().isStopping(agentId),
        runnerHold: input.runnerHold() !== undefined,
        migrating: input.migrations()?.holds(agentId) === true,
      }),
    hasParkedWork: (agentId) =>
      input.deliveryQueue().hasQueued(agentId) || input.deliveryQueue().hasHeldAppItems(agentId),
    flushParked: (agentId) => input.releaseSurvivingHolds(agentId),
    wake: (agentId, restart) => input.wakeAgent(agentId, restart),
    publish: (agentId, launch, ...draft) =>
      input.activityPublisher().publish(agentId, launch, input.activity(agentId, ...draft)),
    handBackMentions: (agentId) => input.mentionDeliveries().handBackForRelaunch(agentId),
    release: (agentId, timeoutMs) => input.processManager().release(agentId, timeoutMs),
  });
}
