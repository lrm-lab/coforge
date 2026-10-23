import {
  normalizeAgentLaunchApps,
  type AgentLaunchApp,
} from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { appsVisibleToAgent } from "./access-rules.server";
import type { AppAgentAccessStore } from "./app-agent-access.server";

/**
 * The apps installed in an Agent's Workspace that it is told about (`appsVisibleToAgent`) for its
 * launch identity (`identity.apps`), in the store's order (by name), bounded and normalised by the
 * SDK's `normalizeAgentLaunchApps`. Built-in Agent Apps are never among them: they are not
 * installed, and their dotted keys are not app keys.
 * It is reference data, so a failure reading it leaves the list empty rather than failing the
 * Agent's launch.
 */
export async function listAgentLaunchApps(
  store: Pick<AppAgentAccessStore, "listInstalledApps" | "listGrantStates">,
  workspaceId: string,
  agentId: string,
): Promise<AgentLaunchApp[]> {
  try {
    const [apps, grants] = await Promise.all([
      store.listInstalledApps(workspaceId),
      store.listGrantStates(agentId),
    ]);
    return normalizeAgentLaunchApps(appsVisibleToAgent(apps, grants, agentId));
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "agent_launch:apps_unavailable",
        workspace_id: workspaceId,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
    return [];
  }
}
