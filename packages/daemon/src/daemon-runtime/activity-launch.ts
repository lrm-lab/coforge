import type { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import type { AgentStartup } from "#src/agent-runtime/agent-startup";
import type { RuntimeErrorClassFence } from "#src/agent-runtime/runtime-error-recovery";
import type {
  buildRuntimeErrorActivity,
  RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import type { OutstandingBackgroundTasks } from "#src/agent-runtime/subagent-progress-activity";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";
import type { ReplyIntentTracker } from "./reply-intent-tracker";
import type { ProviderProgress } from "./stalled-recovery";
import type { StalledTurnTracker } from "./stalled-turn-indicator";

/** What the runtime tracks about one Agent launch's Activity, from start-up to exit. */
export type ActivityLaunch = PublishedActivityLaunch & {
  startup?: AgentStartup;
  trajectory?: Pick<ActivityTrajectory, "flush" | "dispose">;
  /** When the provider last reported anything (`stalled-recovery.ts`). */
  progress?: ProviderProgress;
  /** The launch's open tool calls, and the outcome each one's end reports. */
  toolCalls?: ToolCallLedger;
  /** The busy turn's silence clock: one visible stalled notice per turn. */
  stalled?: StalledTurnTracker;
  /** Reply intents this launch announced; a turn interrupt clears them. */
  replyIntents?: ReplyIntentTracker;
  backgroundTasks?: OutstandingBackgroundTasks;
  // The most recent `error` event not yet resolved by a `completed` event, if any (cleared on
  // `completed`). Read by the process-exit handler to decide `runtime_crashed` vs `idle` wording
  // — `AgentSession.onExit` itself carries no exit code or signal, so this is the only fact the
  // core has for it (see agent-runtime/runtime-error-activity.ts).
  crashDetail?: RuntimeErrorEvent;
  runtimeErrorClassFence?: RuntimeErrorClassFence;
  /** Set when a runtime error took this launch's Agent offline (`#takeAgentOffline`): the exit
   * handler republishes this Activity — never a bare `runtime_crashed` — a launch that then
   * fails reports it instead of a generic launch failure, and a delivery to the offline Agent is
   * kept (queued and ACKed) with this Activity restated. */
  offlineError?: ReturnType<typeof buildRuntimeErrorActivity>;
};
