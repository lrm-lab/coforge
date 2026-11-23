import { createContext, useContext } from "react";
import { Check } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ClockTime, RelativeTime } from "#src/components/ui/relative-time";
import { UnreadBadge } from "#src/components/ui/unread-marker";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export const ActivityRowShortcutsContext = createContext<{
  read?: string;
  done?: string;
}>({});

export function useActivityRowShortcuts() {
  return useContext(ActivityRowShortcutsContext);
}

export const NARROW_SR_ONLY = "@max-[22rem]/activity-list:sr-only";
export const NARROW_HIDDEN = "@max-[22rem]/activity-list:hidden";

export const UNREAD_ROW_CLASS =
  "bg-brand-solid/5 after:pointer-events-none after:absolute after:inset-y-1 after:start-0 after:w-0.75 after:rounded-full after:bg-brand-solid";

export function ActivityRowTitle({
  unread,
  children,
}: {
  unread: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "block min-w-0 truncate text-md",
        unread ? "font-semibold text-primary" : "text-tertiary",
      )}
    >
      {children}
    </span>
  );
}

export function ActivityMentionBadge() {
  return (
    <Badge type="color" size="sm" color="brand">
      @<span className={NARROW_SR_ONLY}>{m.activity_inbox_mention_badge()}</span>
    </Badge>
  );
}

export function ActivityUnreadCount({ count }: { count: number }) {
  return (
    <span dir="ltr" className="inline-flex">
      <span className="sr-only">{m.activity_inbox_new({ count })}</span>
      <UnreadBadge count={count} />
    </span>
  );
}

export function ActivityRowTime({
  value,
  clock,
  current,
}: {
  value: string | Date;
  clock: boolean;
  current: boolean;
}) {
  const className = cn(
    "ms-auto shrink-0 ps-2 text-xs text-quaternary tabular-nums transition-opacity group-hover:opacity-0 not-any-pointer-coarse:group-focus-within:opacity-0",
    current && "not-any-pointer-coarse:opacity-0",
  );
  return clock ? (
    <ClockTime value={value} plain seconds={false} className={className} />
  ) : (
    <RelativeTime value={value} plain className={className} />
  );
}

export function ActivityDoneCheck({
  tabStop,
  current,
  onDone,
}: {
  tabStop: boolean;
  current: boolean;
  onDone: () => void;
}) {
  const { done: doneShortcut } = useActivityRowShortcuts();
  return (
    <ButtonUtility
      icon={Check}
      size="xs"
      color="secondary"
      tooltip={m.activity_inbox_done()}
      tooltipShortcut={doneShortcut}
      aria-label={m.activity_inbox_done()}
      tabIndex={tabStop ? 0 : -1}
      onClick={onDone}
      className={cn(
        "absolute top-1/2 end-[calc(var(--page-gutter)-0.25rem)] -translate-y-1/2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 any-pointer-coarse:hidden",
        current ? "opacity-100" : "opacity-0",
      )}
    />
  );
}
