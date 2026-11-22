import { useCallback, useMemo, useState } from "react";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { compareActivityOrder } from "./activity-inbox-order";
import type { ActivityInboxCursor, ActivityInboxFilter } from "./activity-inbox.schemas";
import { activityItemTime } from "./activity-item-time";
import { openedItemKey } from "./activity-open-target";

type KeptRow = {
  item: ActivityInboxItem;
  after: string | undefined;
  workspaceId: string;
  filter: ActivityInboxFilter;
};

export function useKeptOpenRow(
  filter: ActivityInboxFilter,
  items: ActivityInboxItem[],
  opened: HostedConversationTarget | undefined,
  workspaceId: string,
  cursor: ActivityInboxCursor | null | undefined,
  pinned: ActivityInboxItem[],
) {
  const [selected, setSelected] = useState<string>();
  const [kept, setKept] = useState<KeptRow>();
  const release = useCallback(
    (key: string) => setKept((current) => (current?.item.key === key ? undefined : current)),
    [],
  );
  const openKey = openedItemKey(items, opened);
  const key = openKey ?? (!opened && filter === "all" ? selected : undefined);
  const at = key === undefined ? -1 : items.findIndex((item) => item.key === key);
  const sameRow =
    kept &&
    (opened
      ? openedItemKey([kept.item], opened) === kept.item.key
      : filter === "all" && selected === kept.item.key);
  const retain =
    sameRow &&
    kept.workspaceId === workspaceId &&
    kept.filter === filter &&
    (filter !== "all" ||
      (cursor &&
        "hasUnread" in cursor &&
        !pinned.some((row) => row.key === kept.item.key) &&
        compareActivityOrder(
          {
            key: kept.item.key,
            latestAt: new Date(activityItemTime(kept.item)),
            latestSequence: kept.item.kind === "conversation" ? kept.item.latestSequence : 0,
            hasUnread: kept.item.unreadCount > 0,
          },
          {
            key: cursor.key,
            latestAt: new Date(cursor.at),
            latestSequence: cursor.sequence,
            hasUnread: cursor.hasUnread,
          },
        ) > 0));
  if (at >= 0) {
    const item = items[at]!;
    const after = items[at - 1]?.key;
    if (
      item !== kept?.item ||
      after !== kept.after ||
      filter !== kept.filter ||
      workspaceId !== kept.workspaceId
    )
      setKept({ item, after, workspaceId, filter });
  } else if (kept && !retain) setKept(undefined);

  const shown = useMemo(() => {
    if (at >= 0 || !kept || !retain) return items;
    if (filter === "all") return [...items, kept.item];
    const index = items.findIndex((item) => item.key === kept.after) + 1;
    const read = { ...kept.item, unreadCount: 0, firstUnreadMessageId: null, unreadMention: false };
    return [...items.slice(0, index), read, ...items.slice(index)];
  }, [at, filter, items, kept, retain]);
  return { items: shown, release, selected, setSelected };
}
