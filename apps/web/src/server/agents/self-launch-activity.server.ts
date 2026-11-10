import { encodeAgentActivity, type AgentActivityDetailKind } from "@lrm/coforge-sdk/internal";

import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import { agentActivityChannelFor } from "#src/features/agents/agent-activity";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";

type Scope = { workspaceId: string; computerId: string };

/** A row says what happened by its kind alone; only a failed operation carries a detail. */
export type SelfLaunchRow = {
  detailKind: AgentActivityDetailKind;
  detail: string;
  level: "info" | "error";
};

export type SelfLaunchActivityPorts = {
  record(activities: TrustedAgentActivity[]): Promise<void>;
  publish(channel: string, data: Uint8Array): Promise<void>;
};

/**
 * Writes one row into the Activity of each of `agents`, a launch of its own so the row is never
 * ordered into, or ends, an Agent's run, then publishes it. Publishing is best-effort: the rows
 * are stored first, and a failed publish is logged under `event`.
 */
export async function writeSelfLaunchActivities(
  ports: SelfLaunchActivityPorts,
  scope: Scope,
  input: {
    event: string;
    requestId: string;
    launchId: string;
    agents: readonly { id: string; visibility: AgentVisibility }[];
    row: SelfLaunchRow;
    observedAtMs: number;
  },
): Promise<void> {
  const { agents, requestId } = input;
  if (agents.length === 0) return;
  const activities = agents.map((agent) => ({
    protocolMajor: 1,
    requestId,
    workspaceId: scope.workspaceId,
    agentId: agent.id,
    ...input.row,
    observedAtMs: input.observedAtMs,
    launchId: input.launchId,
    clientSeq: 1,
  }));
  await ports.record(activities.map((activity) => ({ ...activity, computerId: scope.computerId })));
  const published = await Promise.allSettled(
    agents.map((agent, index) =>
      ports.publish(
        agentActivityChannelFor(scope.workspaceId, agent.id, agent.visibility),
        encodeAgentActivity(activities[index]!),
      ),
    ),
  );
  published.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    console.warn(
      JSON.stringify({
        event: input.event,
        outcome: "failed",
        request_id: requestId,
        workspace_id: scope.workspaceId,
        computer_id: scope.computerId,
        agent_id: agents[index]!.id,
        error_type: result.reason instanceof Error ? result.reason.name : typeof result.reason,
      }),
    );
  });
}
