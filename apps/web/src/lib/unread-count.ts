/** The largest count shown as a number; past it, an unread count reads "99+". */
export const UNREAD_COUNT_SHOWN_MAX = 99;

/** An unread count as people read it: the number up to 99, then "99+". */
export function formatUnreadCount(count: number): string {
  return count > UNREAD_COUNT_SHOWN_MAX ? `${UNREAD_COUNT_SHOWN_MAX}+` : String(count);
}
