import { useRef } from "react";
import { ChevronDown } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { CountBadge } from "#src/components/ui/unread-marker";
import { useSlidingIndicator } from "#src/hooks/use-sliding-indicator";
import { formatCappedCount } from "#src/lib/unread-count";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

const FILTER_TABS: ReadonlyArray<{
  id: ActivityInboxFilter;
  label: () => string;
}> = [
  { id: "all", label: () => m.activity_inbox_filter_all() },
  { id: "unread", label: () => m.activity_inbox_filter_unread() },
  { id: "mentions", label: () => m.activity_inbox_filter_mentions() },
  { id: "tasks", label: () => m.activity_inbox_filter_tasks() },
  { id: "artifacts", label: () => m.ag_title() },
];

export function ActivityInboxFilterPicker({
  filter,
  onFilterChange,
  onFilterIntent,
  counts,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  onFilterIntent?: (filter: ActivityInboxFilter) => void;
  counts: Partial<Record<ActivityInboxFilter, number>>;
}) {
  const current = FILTER_TABS.find((tab) => tab.id === filter) ?? FILTER_TABS[0];
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={m.activity_inbox_filter_label()}
        className="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-secondary bg-primary px-2.5 py-1 text-sm font-medium text-secondary outline-focus-ring transition-colors hover:bg-primary_hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span>{current.label()}</span>
        <CountBadge count={counts[current.id]} size="sm" />
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
      </AriaButton>
      <Dropdown.Popover placement="bottom start" className="w-44">
        <Dropdown.Menu
          aria-label={m.activity_inbox_filter_label()}
          selectionMode="single"
          selectedKeys={new Set([filter])}
          onAction={(key) => {
            const next = FILTER_TABS.find((tab) => tab.id === key);
            if (next) onFilterChange(next.id);
          }}
        >
          {FILTER_TABS.map((tab) => (
            <Dropdown.Item
              key={tab.id}
              id={tab.id}
              label={tab.label()}
              addon={formatCappedCount(counts[tab.id]) ?? undefined}
              onHoverStart={() => onFilterIntent?.(tab.id)}
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ActivityInboxUnreadToggle({
  filter,
  unreadCount,
  onFilterChange,
  onFilterIntent,
}: {
  filter: ActivityInboxFilter;
  unreadCount: number | undefined;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  onFilterIntent?: (filter: ActivityInboxFilter) => void;
}) {
  const active = filter === "unread";
  const hasUnread = formatCappedCount(unreadCount) !== null;
  if (!active && !hasUnread) return null;
  const next: ActivityInboxFilter = active ? "all" : "unread";
  return (
    <AriaButton
      aria-pressed={active}
      onPress={() => onFilterChange(next)}
      onHoverStart={() => onFilterIntent?.(next)}
      onFocus={() => onFilterIntent?.(next)}
      className={cn(
        "inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
        active
          ? "bg-active text-primary"
          : "text-tertiary hover:bg-primary_hover hover:text-primary",
      )}
    >
      <span>{m.activity_inbox_filter_unread()}</span>
      <CountBadge count={unreadCount} size="sm" />
    </AriaButton>
  );
}

export function ActivityInboxTabs({
  filter,
  onFilterChange,
  onFilterIntent,
  counts,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  onFilterIntent?: (filter: ActivityInboxFilter) => void;
  counts: Partial<Record<ActivityInboxFilter, number>>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const indicator = useSlidingIndicator(containerRef, {
    activeKey: `${filter}:${counts.unread ?? 0}:${counts.mentions ?? 0}:${counts.tasks ?? 0}:${counts.artifacts ?? 0}`,
    variant: "underline",
  });
  return (
    <div ref={containerRef} className="relative w-max shrink-0">
      <Tabs
        selectedKey={filter}
        onSelectionChange={(key) => {
          const next = FILTER_TABS.find((tab) => tab.id === key);
          if (next) onFilterChange(next.id);
        }}
        className="w-max shrink-0"
      >
        <TabList
          type="underline"
          size="sm"
          aria-label={m.activity_inbox_filter_label()}
          className={cn(
            "before:hidden @max-[22rem]/tabbed-header:gap-2",
            indicator.visible && "[&_[role=tab][aria-selected=true]]:border-transparent",
          )}
        >
          {FILTER_TABS.map((tab) => (
            <Tab
              key={tab.id}
              id={tab.id}
              className={({ isSelected }) =>
                cn("gap-1.5 font-medium", isSelected ? "text-primary" : "text-tertiary")
              }
              onPointerEnter={() => onFilterIntent?.(tab.id)}
              onFocus={() => onFilterIntent?.(tab.id)}
            >
              {() => (
                <>
                  {tab.label()}
                  <CountBadge count={counts[tab.id]} size="sm" />
                </>
              )}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      {indicator.visible && (
        <span
          ref={indicator.indicatorRef}
          aria-hidden="true"
          style={indicator.style}
          className="pointer-events-none absolute bottom-0 left-0 z-20 h-0.5 rounded-full bg-fg-brand-primary_alt"
        />
      )}
    </div>
  );
}
