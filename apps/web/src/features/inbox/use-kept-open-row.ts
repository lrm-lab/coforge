import { useCallback, useMemo, useState } from "react";

import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
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
  selectedItem: ActivityInboxItem | undefined,
) {
  const [selected, setSelected] = useState<string>();
  const [kept, setKept] = useState<KeptRow>();
  const release = useCallback(
    (key: string) => setKept((current) => (current?.item.key === key ? undefined : current)),
    [],
  );
  const candidates = useMemo(() => {
    if (filter !== "all" || !selectedItem || items.some((item) => item.key === selectedItem.key))
      return items;
    return [...items, selectedItem];
  }, [filter, items, selectedItem]);
  const openKey = openedItemKey(candidates, opened);
  const at = filter === "all" || !openKey ? -1 : items.findIndex((item) => item.key === openKey);
  const retain =
    filter !== "all" &&
    kept &&
    kept.workspaceId === workspaceId &&
    kept.filter === filter &&
    openedItemKey([kept.item], opened) === kept.item.key;
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
    if (filter === "all")
      return selectedItem && selectedItem.key === (opened ? openKey : selected)
        ? candidates
        : items;
    if (at >= 0 || !kept || !retain) return items;
    const index = items.findIndex((item) => item.key === kept.after) + 1;
    const read = { ...kept.item, unreadCount: 0, firstUnreadMessageId: null, unreadMention: false };
    return [...items.slice(0, index), read, ...items.slice(index)];
  }, [at, candidates, filter, items, kept, openKey, opened, retain, selected, selectedItem]);
  return { items: shown, release, selected, setSelected };
}
