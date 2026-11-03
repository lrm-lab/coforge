import type { Collection } from "@tanstack/react-db";

import type { ChannelSignal } from "./channel-signals";
import type { ChannelRow } from "./sidebar-queries";

/**
 * Applies a channel created, changed or gone anywhere in the Workspace to the synced list, with
 * no read: a new channel is listed as one the viewer has not joined (their own join arrives as
 * a `ViewerEvent`), and a changed one takes its new name and archived state and keeps the
 * viewer's place in it. False when the list cannot place it and must be read again: it has not
 * synced yet, a sidebar change is still being saved (whose rollback, if the save fails, would
 * undo a direct write too), the event names only ids, or it is a channel the list has never
 * heard of coming back (`#general` restored, whose place for the viewer the event does not
 * carry). `known`: every channel's name has it, so a channel the list leaves out on purpose
 * (closed) stays out.
 */
export function channelSignalApplier(
  channels: Collection<ChannelRow, string>,
  /** Whether a sidebar change is still being saved, whose rollback would undo a direct write. */
  saving: () => boolean,
) {
  return (signal: ChannelSignal, { known }: { known: boolean }): boolean => {
    if (channels.status !== "ready" || saving()) return false;
    const id = signal.conversationId;
    if (signal.type === "channel.updated.v1" && signal.gone) {
      if (channels.has(id)) channels.utils.writeDelete(id);
      return true;
    }
    if (!signal.channel) return false;
    const { name, archived, visibility } = signal.channel;
    if (channels.has(id)) channels.utils.writeUpdate({ id, name, archived, visibility });
    else if (signal.type === "channel.created.v1")
      channels.utils.writeInsert({
        id,
        name,
        joined: false,
        archived,
        visibility,
        muted: false,
        notificationLevel: "all",
        unreadCount: 0,
        mentioned: false,
        lastMessage: null,
        members: [],
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      });
    else return known;
    return true;
  };
}
