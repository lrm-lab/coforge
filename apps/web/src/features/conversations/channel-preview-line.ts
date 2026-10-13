/** Who sent a channel's last message, as the row's preview line names them. */
export type ChannelPreviewSender = {
  kind: "user" | "agent" | "system";
  name: string;
  /** The viewer sent it. */
  mine: boolean;
};

/**
 * A channel row's second line: `Sender: preview`, with the viewer's own messages under `youLabel`
 * and no prefix for a system message. `null` when there is no preview text, so the row shows only
 * its name line.
 */
export function channelPreviewLine({
  sender,
  preview,
  youLabel,
}: {
  sender: ChannelPreviewSender;
  preview: string;
  youLabel: string;
}): string | null {
  const text = preview.trim();
  if (!text) return null;
  if (sender.kind === "system") return text;
  return `${sender.mine ? youLabel : sender.name}: ${text}`;
}

/**
 * Whether a channel row shows its "@" mention badge: the viewer is mentioned and the mention is
 * still unread. The server's `mentioned` flag does not clear when the viewer opens the channel, so
 * the row's live unread count decides it; a muted channel's unread count is the same signal, shown
 * as a dot.
 */
export function channelMentionShown({
  mentioned,
  unreadCount,
}: {
  mentioned: boolean;
  unreadCount: number | undefined;
}): boolean {
  return mentioned && (unreadCount ?? 0) > 0;
}
