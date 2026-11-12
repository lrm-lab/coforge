import { useCallback, useMemo, useState } from "react";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { openedItemKey } from "./activity-open-target";

type KeptRow = { item: ActivityInboxItem; after: string | undefined };

/**
 * In a view that leaves out what was read (Unread, Mentions), the row the pane shows stays in the
 * list, read, until the pane moves on, as Linear's inbox keeps it: opening a row reads it, and
 * the server's next list leaves it out, which pulled the row, and the caret on it, from under the
 * viewer, so j could not walk the view. It stays after the row it followed. A row marked Done
 * leaves at once (`release`).
 */
export function useKeptOpenRow(
  filter: ActivityInboxFilter,
  items: ActivityInboxItem[],
  opened: HostedConversationTarget | undefined,
) {
  const [kept, setKept] = useState<KeptRow>();
  const release = useCallback(
    (key: string) => setKept((current) => (current?.item.key === key ? undefined : current)),
    [],
  );
  const showsKept = kept !== undefined && openedItemKey([kept.item], opened) === kept.item.key;

  // The server's own row the pane shows, and the one before it, adjusted while rendering (React's
  // "storing information from previous renders"): it changes only when the list or the pane does.
  const openKey = filter === "all" ? undefined : openedItemKey(items, opened);
  const at = openKey === undefined ? -1 : items.findIndex((item) => item.key === openKey);
  if (at >= 0) {
    const item = items[at]!;
    const after = items[at - 1]?.key;
    if (item !== kept?.item || after !== kept?.after) setKept({ item, after });
  } else if (kept && (filter === "all" || !showsKept)) setKept(undefined);

  const shown = useMemo(() => {
    if (filter === "all" || !kept || !showsKept) return items;
    if (items.some((item) => item.key === kept.item.key)) return items;
    const index = items.findIndex((item) => item.key === kept.after) + 1;
    const read = { ...kept.item, unreadCount: 0, firstUnreadMessageId: null, unreadMention: false };
    return [...items.slice(0, index), read, ...items.slice(index)];
  }, [filter, items, kept, showsKept]);
  return { items: shown, release };
}
