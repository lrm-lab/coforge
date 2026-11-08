import { getDatabaseClient } from "#src/server/db/client.server";
import { taskConversationsEnabled } from "#src/server/tasks/task-conversations-gate.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";

/**
 * The Workspace's features a delivery tells its Agent's daemon, so a session launched with other
 * values restarts before it takes the input. Read once per publish; a database that cannot say
 * leaves the field out, and the daemon then keeps what its session was launched with.
 */
export async function deliveryFeatures(
  workspaceId: string,
): Promise<{ taskConversations: boolean; artifacts: boolean } | undefined> {
  const db = getDatabaseClient();
  if (!db) return undefined;
  try {
    const [taskConversations, artifacts] = await Promise.all([
      taskConversationsEnabled(db, { workspaceId }),
      artifactsEnabled(db, workspaceId),
    ]);
    return { taskConversations, artifacts };
  } catch {
    return undefined;
  }
}
