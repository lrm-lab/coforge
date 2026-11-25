export const UNREAD_COUNT_SHOWN_MAX = 99;

export function formatUnreadCount(count: number): string {
  return count > UNREAD_COUNT_SHOWN_MAX ? `${UNREAD_COUNT_SHOWN_MAX}+` : String(count);
}

export function formatCappedCount(count: number | null | undefined): string | null {
  if (count == null || !Number.isFinite(count)) return null;
  const whole = Math.floor(count);
  if (whole <= 0) return null;
  return formatUnreadCount(whole);
}
