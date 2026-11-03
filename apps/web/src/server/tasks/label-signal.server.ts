import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { LabelChangedEvent, LabelGroupChangedEvent } from "#src/features/tasks/label-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { LabelGroupRow } from "./label-groups.server";
import type { LabelRow } from "./labels.server";

/**
 * Tells the Workspace's open pages that a label or a label group was created, changed or deleted.
 * The write has committed, so a failed signal never fails it: a page that missed it reads the
 * labels on its next load, and a Task's membership still rides `task.changed.v1`.
 */

export async function announceLabelChanged(
  centrifugo: Pick<CentrifugoServerApi, "publishJson">,
  workspaceId: string,
  change: { label: LabelRow | null; deletedLabelId?: string },
) {
  const event: LabelChangedEvent = {
    type: REALTIME_EVENTS.labelChanged,
    workspaceId,
    label: change.label
      ? {
          id: change.label.id,
          name: change.label.name,
          color: change.label.color,
          description: change.label.description,
          group: change.label.group
            ? {
                id: change.label.group.id,
                name: change.label.group.name,
                selection: change.label.group.selection,
              }
            : null,
          archived: change.label.archivedAt !== null,
        }
      : null,
    ...(change.deletedLabelId ? { deletedLabelId: change.deletedLabelId } : {}),
  };
  await centrifugo
    .publishJson(workspaceConversationChannel(workspaceId), event)
    .catch(() => undefined);
}

export async function announceLabelGroupChanged(
  centrifugo: Pick<CentrifugoServerApi, "publishJson">,
  workspaceId: string,
  change: { group: LabelGroupRow | null; deletedGroupId?: string },
) {
  const event: LabelGroupChangedEvent = {
    type: REALTIME_EVENTS.labelGroupChanged,
    workspaceId,
    group: change.group
      ? { id: change.group.id, name: change.group.name, selection: change.group.selection }
      : null,
    ...(change.deletedGroupId ? { deletedGroupId: change.deletedGroupId } : {}),
  };
  await centrifugo
    .publishJson(workspaceConversationChannel(workspaceId), event)
    .catch(() => undefined);
}

/** A Task's view of a label, for a caller that only has the row. */
export type { TaskLabel };
