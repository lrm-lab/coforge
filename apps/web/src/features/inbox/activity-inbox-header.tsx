import type { ReactNode } from "react";

import {
  PANE_HEADER_ATTR,
  PANE_HEADER_CLASS,
  PANE_SUBBAR_ATTR,
  PANE_SUBBAR_CLASS,
} from "#src/components/layout/pane-header";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import {
  ActivityInboxFilterPicker,
  ActivityInboxTabs,
  ActivityInboxUnreadToggle,
} from "./activity-inbox-tabs";

export function ActivityInboxHeader({
  desktop,
  activeCount,
  filter,
  onFilterChange,
  onFilterIntent,
  counts,
  moreActions,
}: {
  desktop: boolean;
  activeCount: number | undefined;
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  onFilterIntent: (filter: ActivityInboxFilter) => void;
  counts: Partial<Record<ActivityInboxFilter, number>>;
  moreActions: ReactNode;
}) {
  if (desktop) {
    return (
      <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "justify-between gap-2 px-4")}>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-lg font-semibold text-primary">{m.navigation_activity()}</h1>
          {activeCount !== undefined && (
            <span data-activity-active-count className="sr-only">
              {m.activity_inbox_active_count({ count: activeCount })}
            </span>
          )}
          <ActivityInboxFilterPicker
            filter={filter}
            onFilterChange={onFilterChange}
            onFilterIntent={onFilterIntent}
            counts={counts}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ActivityInboxUnreadToggle
            filter={filter}
            unreadCount={counts.unread}
            onFilterChange={onFilterChange}
            onFilterIntent={onFilterIntent}
          />
          {moreActions && <div className="-me-1.5 flex items-center">{moreActions}</div>}
        </div>
      </header>
    );
  }

  return (
    <>
      <TabHomeHeader
        title={m.navigation_activity()}
        meta={
          activeCount !== undefined && (
            <span data-activity-active-count className="text-xs text-quaternary tabular-nums">
              {m.activity_inbox_active_count({ count: activeCount })}
            </span>
          )
        }
      />
      <div {...PANE_SUBBAR_ATTR} className={cx(PANE_SUBBAR_CLASS, "gap-2 px-4")}>
        <ActivityInboxTabs
          filter={filter}
          onFilterChange={onFilterChange}
          onFilterIntent={onFilterIntent}
          counts={counts}
        />
        {moreActions && <div className="-me-1.5 flex shrink-0 items-center">{moreActions}</div>}
      </div>
    </>
  );
}
