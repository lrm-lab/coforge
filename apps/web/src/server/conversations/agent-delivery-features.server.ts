import { getDatabaseClient } from "#src/server/db/client.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

export async function deliveryFeatures(
  workspaceId: string,
): Promise<
  { taskConversations: boolean; artifacts: boolean; agentContextView: boolean } | undefined
> {
  const db = getDatabaseClient();
  if (!db) return undefined;
  try {
    const agentContextView = await isFeatureEnabled("agentContextView", { workspaceId });
    return { taskConversations: true, artifacts: true, agentContextView };
  } catch {
    return undefined;
  }
}
