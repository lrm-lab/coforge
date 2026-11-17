import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

export const activityItemTime = (item: ActivityInboxItem) =>
  item.kind === "artifact" ? item.at : item.latest.createdAt;
