import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { WorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/**
 * Tells every open page of the Workspace that what it offers changed. The switch has committed, so
 * a failed signal never fails it: a page that missed the event reads its features on its next load.
 */
export async function announceFeaturesChanged(
  centrifugo: Pick<CentrifugoServerApi, "publishJson">,
  workspaceId: string,
) {
  const event: WorkspaceFeaturesChangedEvent = {
    type: "workspace.features.changed.v1",
    workspaceId,
  };
  await centrifugo
    .publishJson(workspaceConversationChannel(workspaceId), event)
    .catch(() => undefined);
}
