import { RollingNumber } from "#src/components/ui/rolling-number";
import { UNREAD_COUNT_SHOWN_MAX } from "#src/lib/unread-count";
import { cx } from "#src/utils/cx";

/** Slack-style badge: the count up to 99, then "99+". Hidden from AT, so the row that owns it
 * names the unread count in its own label. `className` only positions it. Unread is a near-black pill (dark gray in dark mode), so the multi-colored Agent avatars carry the color. */
export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary-solid px-1.5 dark:bg-secondary-solid text-xs font-semibold leading-none text-white tabular-nums",
        className,
      )}
    >
      <RollingNumber value={Math.min(count, UNREAD_COUNT_SHOWN_MAX)} />
      {count > UNREAD_COUNT_SHOWN_MAX && "+"}
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
      className={cx(
        "inline-flex size-2 shrink-0 rounded-full bg-primary-solid dark:bg-secondary-solid",
        className,
      )}
    />
  );
}
