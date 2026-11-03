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
 * Whether a channel row shows its "@" mention badge: the server says the viewer is mentioned and
 * has not handled it. A muted channel still counts unread (it only stops pushing), so the badge
 * does not depend on that; the next list read clears `mentioned` once the viewer has read it.
 */
export function channelMentionShown({ mentioned }: { mentioned: boolean }): boolean {
  return mentioned;
}
