import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { LabelChangedEvent } from "#src/features/tasks/label-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/**
 * Tells the Workspace's open pages that a label was created, renamed or deleted. The write has
 * committed, so a failed signal never fails it: a page that missed it reads the labels on its next
 * load, and a Task's membership still rides `task.changed.v1`.
 */
export async function announceLabelChanged(
  centrifugo: Pick<CentrifugoServerApi, "publishJson">,
  workspaceId: string,
  change: { label: TaskLabel | null; deletedLabelId?: string },
) {
  const event: LabelChangedEvent = {
    type: REALTIME_EVENTS.labelChanged,
    workspaceId,
    label: change.label,
    ...(change.deletedLabelId ? { deletedLabelId: change.deletedLabelId } : {}),
  };
  await centrifugo
    .publishJson(workspaceConversationChannel(workspaceId), event)
    .catch(() => undefined);
}
