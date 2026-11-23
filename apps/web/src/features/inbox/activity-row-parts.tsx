import { createContext, useContext } from "react";
import { Check } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ClockTime, RelativeTime } from "#src/components/ui/relative-time";
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

export function ActivityUnreadDot({ current = false }: { current?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -top-0.5 -start-0.5 z-10 size-2 rounded-full bg-brand-solid ring-2 transition-shadow",
        current ? "ring-bg-active" : "ring-bg-primary group-hover:ring-bg-primary_hover",
      )}
    />
  );
}

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
        "block min-w-0 truncate text-sm",
        unread ? "font-semibold text-primary" : "text-tertiary",
      )}
    >
      {children}
    </span>
  );
}

export function ActivityMentionBadge() {
  return (
    <span className="shrink-0 text-xs font-medium text-(--color-reference-text)">
      @<span className={NARROW_SR_ONLY}>{m.activity_inbox_mention_badge()}</span>
    </span>
  );
}

export function ActivityUnreadCount({ count }: { count: number }) {
  return (
    <span dir="ltr" className="shrink-0 text-xs font-medium text-tertiary tabular-nums">
      <span className="sr-only">{m.activity_inbox_new({ count })}</span>
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
    </span>
  );
}

export function activityRowMetaFadeClass(current: boolean) {
  return cn(
    "transition-opacity not-any-pointer-coarse:group-hover:opacity-0 not-any-pointer-coarse:group-focus-within:opacity-0",
    current && "not-any-pointer-coarse:opacity-0",
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
    "ms-auto shrink-0 ps-2 text-xs text-quaternary tabular-nums",
    activityRowMetaFadeClass(current),
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
        "absolute top-1/2 end-2.5 -translate-y-1/2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 any-pointer-coarse:hidden",
        current ? "opacity-100" : "opacity-0",
      )}
    />
  );
}
