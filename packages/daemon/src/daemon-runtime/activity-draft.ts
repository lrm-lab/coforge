import {
  AGENT_ACTIVITY_DETAIL_KIND,
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentActivity,
} from "@lrm/coforge-sdk/internal";
import type { ActivityDraft } from "./agent-activity-publisher";

/**
 * The Activity envelope every row the daemon publishes is built from: the workspace and Agent it
 * belongs to, the frame, and whatever the caller adds. The launch supplies the sequence metadata
 * that is missing here (`AgentActivityPublisher.publish`).
 */
export function activityDraft(
  workspaceId: string,
  agentId: string,
  detailKind: AgentActivity["detailKind"],
  level: AgentActivity["level"],
  detail: string,
  extra: Partial<ActivityDraft> = {},
): ActivityDraft {
  return {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    requestId: crypto.randomUUID(),
    workspaceId,
    agentId,
    detailKind,
    level,
    detail,
    ...extra,
  };
}

/** The launch has been resolved and the runtime is about to spawn. */
export function startingActivityDraft(workspaceId: string, agentId: string): ActivityDraft {
  return activityDraft(
    workspaceId,
    agentId,
    AGENT_ACTIVITY_DETAIL_KIND.STARTING,
    "info",
    "Starting…",
  );
}

export function idleActivityDraft(workspaceId: string, agentId: string): ActivityDraft {
  return activityDraft(workspaceId, agentId, AGENT_ACTIVITY_DETAIL_KIND.IDLE, "info", "Idle");
}

export function stoppedActivityDraft(workspaceId: string, agentId: string): ActivityDraft {
  return activityDraft(workspaceId, agentId, AGENT_ACTIVITY_DETAIL_KIND.STOPPED, "info", "Stopped");
}

/** The row showing a turn that ended without an error: still working while tasks it started run in
 * the background, otherwise the Idle row that ends the Agent's working stretch. */
export function quietTurnActivityDraft(
  workspaceId: string,
  agentId: string,
  backgroundDetail: string | undefined,
): ActivityDraft {
  return backgroundDetail
    ? activityDraft(
        workspaceId,
        agentId,
        AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
        "info",
        backgroundDetail,
      )
    : idleActivityDraft(workspaceId, agentId);
}

/** A running turn was cut by a requested stop or restart. */
export function interruptedActivityDraft(workspaceId: string, agentId: string): ActivityDraft {
  return activityDraft(
    workspaceId,
    agentId,
    AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
    "info",
    "Turn stopped",
  );
}

/** An error-level row, with an optional typed `runtimeError` carrying the machine-readable reason. */
export function runtimeErrorActivityDraft(
  workspaceId: string,
  agentId: string,
  detail: string,
  runtimeError?: ActivityDraft["runtimeError"],
): ActivityDraft {
  return activityDraft(
    workspaceId,
    agentId,
    AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    "error",
    detail,
    runtimeError ? { runtimeError } : {},
  );
}
