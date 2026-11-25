import { MessageChatCircle } from "@untitledui/icons";

import { RollingNumber } from "#src/components/ui/rolling-number";
import { formatCappedCount, UNREAD_COUNT_SHOWN_MAX } from "#src/lib/unread-count";
import { cx } from "#src/utils/cx";

function UnreadNumber({ count }: { count: number }) {
  return (
    <span dir="ltr" className="inline-flex items-center">
      <RollingNumber value={Math.min(count, UNREAD_COUNT_SHOWN_MAX)} />
      {count > UNREAD_COUNT_SHOWN_MAX && "+"}
    </span>
  );
}

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (!Number.isFinite(count) || Math.floor(count) <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-unread-capsule px-1.5 text-xs leading-none font-semibold whitespace-nowrap text-unread-capsule-fg tabular-nums",
        className,
      )}
    >
      <UnreadNumber count={Math.floor(count)} />
    </span>
  );
}

export type CountBadgeTone = "subtle" | "solid";
export type CountBadgeSize = "sm" | "md";

export function CountBadge({
  count,
  tone = "subtle",
  size = "md",
  srLabel,
  className,
}: {
  count: number | null | undefined;
  tone?: CountBadgeTone;
  size?: CountBadgeSize;
  srLabel?: string;
  className?: string;
}) {
  const label = formatCappedCount(count);
  if (!label) return null;
  return (
    <span
      dir="ltr"
      aria-hidden={srLabel ? undefined : true}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full text-xs leading-none whitespace-nowrap tabular-nums",
        size === "sm" ? "h-[1.125rem] min-w-[1.125rem] px-1" : "h-5 min-w-5 px-1.5",
        tone === "solid"
          ? "bg-unread-capsule font-semibold text-unread-capsule-fg"
          : "bg-tertiary font-medium text-secondary",
        className,
      )}
    >
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
      <span aria-hidden={srLabel ? true : undefined}>{label}</span>
    </span>
  );
}

export function UnreadCapsule({
  unreadCount = 0,
  unreadThreadCount = 0,
  subdued,
  className,
}: {
  unreadCount?: number;
  unreadThreadCount?: number;
  subdued?: boolean;
  className?: string;
}) {
  const hasMessages = unreadCount > 0;
  const hasThreads = unreadThreadCount > 0;
  if (!hasMessages && !hasThreads) return null;
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold leading-none tabular-nums",
        subdued
          ? "bg-unread-capsule-muted text-unread-capsule-muted-fg"
          : "bg-unread-capsule text-unread-capsule-fg",
        className,
      )}
    >
      {hasMessages ? <UnreadNumber count={unreadCount} /> : null}
      {hasMessages && hasThreads ? (
        <span
          className={cx(
            "mx-1.5 h-3 w-px shrink-0",
            subdued ? "bg-unread-capsule-muted-divider" : "bg-unread-capsule-divider",
          )}
        />
      ) : null}
      {hasThreads ? (
        <span className="inline-flex items-center gap-1">
          <MessageChatCircle aria-hidden="true" className="size-3 shrink-0 [stroke-width:2.25]" />
          <UnreadNumber count={unreadThreadCount} />
        </span>
      ) : null}
    </span>
  );
}

/** The unread marker without a number: "there is something here", not "how much". Used where the
 * marker sits on an icon or a row — a count on a small glyph is noise, and the sidebar keeps the
 * numbers. `className` only positions it (`ml-auto`, absolute offsets). */
export function UnreadDot({ subdued, className }: { subdued?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-2 shrink-0 rounded-full",
        subdued ? "bg-unread-capsule-muted-fg" : "bg-unread-capsule",
        className,
      )}
    />
  );
}
