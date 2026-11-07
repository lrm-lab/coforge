import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import {
  OutstandingBackgroundTasks,
  SubagentWakeTracker,
} from "#src/agent-runtime/subagent-progress-activity";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import type { ReplyIntentTracker } from "./reply-intent-tracker";
import type { LaunchRequest } from "./runtime-launch-types";
import { ProviderProgress } from "./stalled-recovery";
import {
  StalledTurnTracker,
  stalledTurnNotice,
  stalledTurnSilenceMs,
} from "./stalled-turn-indicator";

/** The observation tracks one launch feeds its event stream into: the coalescing trajectory,
 * the provider-progress clock the stalled sweep reads, the open-tool ledger, the reply-intent
 * tracker, and the trackers parked on the launch record itself. */
export type AgentLaunchTracking = {
  trajectory: {
    accept(event: AgentRuntimeEvent): void;
    flush(): void;
    dispose(): void;
  };
  progress: ProviderProgress;
  toolCalls: ToolCallLedger;
  replyIntents: ReplyIntentTracker;
};

/** Builds and registers every per-launch observation track. */
export function trackAgentLaunch(
  ports: AgentLaunchCoordinatorPorts,
  agentId: string,
  launch: ActivityLaunch,
  config: AgentRuntimeConfig,
  runtime: AgentRuntime,
  control: LaunchRequest["control"],
): AgentLaunchTracking {
  const trajectories = new Map<string, ActivityTrajectory>();
  const trajectoryFor = (scope: AgentRuntimeEvent["conversation"]) => {
    const key = scope?.conversationId ?? "";
    let trajectory = trajectories.get(key);
    if (!trajectory) {
      trajectory = new ActivityTrajectory((event) =>
        ports.observeRuntimeEvent(agentId, launch, config, runtime, Boolean(control), {
          ...event,
          ...(scope ? { conversation: scope } : {}),
        }),
      );
      trajectories.set(key, trajectory);
    }
    return trajectory;
  };
  const trajectory = {
    accept: (event: AgentRuntimeEvent) => trajectoryFor(event.conversation).accept(event),
    flush: () => {
      for (const item of trajectories.values()) item.flush();
    },
    dispose: () => {
      for (const item of trajectories.values()) item.dispose();
      trajectories.clear();
    },
  };
  launch.trajectory = trajectory;
  const progress = new ProviderProgress();
  launch.progress = progress;
  const toolCalls = new ToolCallLedger();
  launch.toolCalls = toolCalls;
  launch.stalled = new StalledTurnTracker(
    stalledTurnNotice(launch, {
      isCurrent: (id) => ports.currentActivityLaunches.get(id) === launch,
      publish: (id, detail) =>
        ports.activityPublisher.publish(
          id,
          launch,
          ports.activity(id, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED, "error", detail),
        ),
    }),
    stalledTurnSilenceMs(config.envVars),
  );
  const replyIntents = ports.replyIntents.tracker(agentId, launch);
  launch.replyIntents = replyIntents;
  launch.backgroundTasks = new OutstandingBackgroundTasks();
  if (runtime.session.wakesAfterSubagents === true) launch.subagentWake = new SubagentWakeTracker();
  return { trajectory, progress, toolCalls, replyIntents };
}
