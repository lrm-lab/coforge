import { m } from "#src/paraglide/messages";

export function replyCountLabel(count: number): string {
  return count === 1 ? m.conversation_thread_one_reply() : m.conversation_thread_replies({ count });
}

export function withUnreadCount(label: string, unread: number): string {
  return unread > 0 ? `${label}, ${m.conversation_thread_unread({ count: unread })}` : label;
}
