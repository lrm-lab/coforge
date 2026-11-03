import { m } from "#src/paraglide/messages";

/** A person's notification level in a channel (task #400); a DM has only `all` and `muted`. */
export const CHANNEL_NOTIFICATION_LEVELS = ["all", "relevant", "none", "muted"] as const;
export type ChannelNotificationLevel = (typeof CHANNEL_NOTIFICATION_LEVELS)[number];

/** A row's level: a copy stored before rows carried it has only `muted`. */
export function notificationLevelOf(row: {
  notificationLevel?: ChannelNotificationLevel;
  muted?: boolean;
}): ChannelNotificationLevel {
  return row.notificationLevel ?? (row.muted ? "muted" : "all");
}

export function notificationLevelLabel(level: ChannelNotificationLevel): string {
  switch (level) {
    case "all":
      return m.channel_notify_all();
    case "relevant":
      return m.channel_notify_relevant();
    case "none":
      return m.channel_notify_none();
    case "muted":
      return m.channel_notify_muted();
  }
}

/** What a level does, in a line: what pushes and what the list counts. */
export function notificationLevelDescription(level: ChannelNotificationLevel): string {
  switch (level) {
    case "all":
      return m.channel_notify_all_description();
    case "relevant":
      return m.channel_notify_relevant_description();
    case "none":
      return m.channel_notify_none_description();
    case "muted":
      return m.channel_notify_muted_description();
  }
}
