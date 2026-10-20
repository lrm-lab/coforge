import {
  normalizeAgentLaunchApps,
  type AgentLaunchApp,
} from "@lrm/coforge-sdk/internal/agent-launch-apps";
import type { AppAgentAccessStore } from "./app-agent-access.server";

/**
 * The apps installed in an Agent's Workspace for its launch identity (`identity.apps`), in the
 * store's order (by name), bounded and normalised by the SDK's `normalizeAgentLaunchApps`. Built-in
 * Agent Apps are never among them: they are not installed, and their dotted keys are not app keys.
 * It is reference data, so a failure reading it leaves the list empty rather than failing the
 * Agent's launch.
 */
export async function listAgentLaunchApps(
  store: Pick<AppAgentAccessStore, "listInstalledApps">,
  workspaceId: string,
): Promise<AgentLaunchApp[]> {
  try {
    return normalizeAgentLaunchApps(await store.listInstalledApps(workspaceId));
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
