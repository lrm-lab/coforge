import { useMemo } from "react";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { useActivityDays } from "./activity-inbox-days";
import { activityItemTime } from "./activity-item-time";

export function useActivityInboxGroups(
  filter: ActivityInboxFilter,
  items: ActivityInboxItem[],
  pinned: ActivityInboxItem[],
) {
  const unread = useMemo(
    () => (filter === "all" ? items.filter((item) => item.unreadCount > 0) : []),
    [filter, items],
  );
  const dated = useMemo(
    () => (filter === "all" ? items.filter((item) => !item.unreadCount) : items),
    [filter, items],
  );
  const days = useActivityDays(dated, activityItemTime);
  const rows = useMemo(
    () => [...unread, ...pinned, ...days.flatMap((day) => day.items)],
    [unread, pinned, days],
  );
  return { unread, days, rows };
}
