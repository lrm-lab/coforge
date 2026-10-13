import { cx } from "#src/utils/cx";

/** Slack-style badge: the count up to 99, then "99+". Hidden from AT, so the row that owns it
 * names the unread count in its own label. Unread is the brand violet, as the design draft's conversation list draws it (white on it is about 6.9:1). */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-solid px-1.5 text-xs font-semibold leading-none text-white tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The unread marker without a number: "there is something here", not "how much". Used where the
 * marker sits on an icon or a row — a count on a small glyph is noise, and the sidebar keeps the
 * numbers. `className` only positions it (`ml-auto`, absolute offsets). */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-flex size-2 shrink-0 rounded-full bg-brand-solid", className)}
    />
  );
}
