import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";

export function formatConversationCount(count: number): string {
  return formatNumber(count);
}

export function replyCountLabel(count: number): string {
  return m.conversation_thread_replies({ count });
}

export function unreadCountLabel(count: number): string {
  return m.conversation_thread_unread({ count });
}

export function withUnreadCount(label: string, unread: number): string {
  return unread > 0 ? `${label}, ${unreadCountLabel(unread)}` : label;
}
