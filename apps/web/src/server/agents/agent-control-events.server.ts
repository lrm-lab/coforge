import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import {
  agentStatusChannel,
  agentStatusChannelFor,
} from "#src/features/agents/agent-status-channel";
import type { AgentControlAction } from "./agent-control-types.server";

/** The browser-facing phase of one control operation, from `agent.control.v1`. */
export type AgentControlEventPhase = "accepted" | "pending" | "completed" | "failed" | "superseded";

export type AgentControlEvent = {
  agentId: string;
  requestId: string;
  action: AgentControlAction;
  phase: AgentControlEventPhase;
  errorCode?: string;
  detail?: string;
};

type Visibility = { id: string; workspaceId: string; visibility: string };

/** `occurredAtMs` must order the events one operation emits within a millisecond: a superseded
 * and the pending that replaces it can share `Date.now()`, and the browser keeps the newer
 * timestamp, so the clock is nudged forward whenever it would not advance. */
let lastEventMs = 0;
const nextEventMs = () => (lastEventMs = Math.max(Date.now(), lastEventMs + 1));

/**
 * Publishes `agent.control.v1` on the Agent status channels. An event carrying an error code or
 * detail goes only to the visibility-routed channel, so a private Agent's failure words stay
 * with the viewers who may see it; a phase-only event goes to the shared Workspace channel, so
 * every member sees "正在重启"-style pending state. Publication is best effort and never throws:
 * the control operation it narrates must not fail on a realtime write.
 */
export class AgentControlEvents {
  constructor(
    private readonly api: {
      publishJson?(channel: string, data: unknown): Promise<unknown>;
    },
  ) {}

  publish(agent: Visibility, event: AgentControlEvent): void {
    const publishJson = this.api.publishJson;
    if (!publishJson) return;
    const data = {
      type: REALTIME_EVENTS.agentControl,
      agentId: event.agentId,
      requestId: event.requestId,
      action: event.action,
      phase: event.phase,
      ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      occurredAtMs: nextEventMs(),
    };
    const routed = agentStatusChannelFor(agent.workspaceId, agent.id, agent.visibility);
    const shared = agentStatusChannel(agent.workspaceId);
    const carriesError = event.errorCode !== undefined || event.detail !== undefined;
    void (async () => {
      if (carriesError) {
        await publishJson.call(this.api, routed, data);
        return;
      }
      // Phase-only events are for every member: the shared channel alone reaches them all,
      // including viewers who cannot see a private Agent's routed channel.
      await publishJson.call(this.api, shared, data);
    })().catch(() => {});
  }
}
