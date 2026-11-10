import {
  AGENT_ACTIVITY_DETAIL_KIND,
  CREDENTIAL_FAILURE_ERROR_REASONS,
  type AgentCredentialRestored,
} from "@lrm/coforge-sdk/internal";

import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { writeSelfLaunchActivities } from "./self-launch-activity.server";

type Scope = { workspaceId: string; computerId: string };

export type CredentialRestoredActivityPorts = {
  /** The active Agents assigned to the Computer. */
  agents(scope: Scope): Promise<{ id: string; visibility: AgentVisibility }[]>;
  /** The Agent's newest stored Activity, if it has one. */
  newest(
    workspaceId: string,
    agentId: string,
  ): Promise<
    | {
        detailKind: string;
        runtimeErrorReason?: string | null;
        occurredAtMs?: number;
      }
    | undefined
  >;
  record(activities: TrustedAgentActivity[]): Promise<void>;
  publish(channel: string, data: Uint8Array): Promise<void>;
};

/**
 * An Agent's daemon reports its provider credential works again. The failure the Agent showed
 * (an error Activity telling a person to sign in, change the model or add credit) is over, so the
 * Agent's Activity leaves it with an idle row of its own. Only when that very failure is still the
 * newest thing it showed: an Agent that already went on to work, was shown another error, or was
 * never shown the failure gets nothing, so a late report never turns a working Agent idle. The row
 * is dated by the daemon's clock, the one its own Activities carry, so whatever the Agent does
 * next is ordered after it; never before the failure it ends.
 */
export class CredentialRestoredActivity {
  constructor(private readonly ports: CredentialRestoredActivityPorts) {}

  /** False when the Agent is not an active Agent of the Computer. */
  async receive(scope: Scope, report: AgentCredentialRestored): Promise<boolean> {
    const agent = (await this.ports.agents(scope)).find(({ id }) => id === report.agentId);
    if (!agent) return false;
    const newest = await this.ports.newest(scope.workspaceId, agent.id);
    if (
      newest?.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR ||
      newest.runtimeErrorReason !== CREDENTIAL_FAILURE_ERROR_REASONS[report.reason]
    )
      return true;
    await writeSelfLaunchActivities(this.ports, scope, {
      event: "credential_restored_activity.publish_failed",
      requestId: report.requestId,
      launchId: `credential-restored:${report.requestId}`,
      agents: [agent],
      row: { detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE, detail: "", level: "info" },
      observedAtMs: Math.max(report.restoredAtMs, (newest.occurredAtMs ?? 0) + 1),
    });
    return true;
  }
}
