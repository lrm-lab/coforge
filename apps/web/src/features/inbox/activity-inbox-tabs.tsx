import { useRef } from "react";
import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { useSlidingIndicator } from "#src/hooks/use-sliding-indicator";
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
  { id: "artifacts", label: () => m.ag_title() },
];

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
    activeKey: `${filter}:${counts.unread ?? 0}:${counts.mentions ?? 0}:${counts.artifacts ?? 0}`,
    variant: "pill",
  });
  return (
    <div ref={containerRef} className="relative w-max shrink-0">
      {indicator.visible && (
        <span
          ref={indicator.indicatorRef}
          aria-hidden="true"
          style={indicator.style}
          className="pointer-events-none absolute top-0 left-0 z-0 rounded-md bg-primary_hover will-change-transform"
        />
      )}
      <Tabs
        selectedKey={filter}
        onSelectionChange={(key) => {
          const next = FILTER_TABS.find((tab) => tab.id === key);
          if (next) onFilterChange(next.id);
        }}
        className="w-max shrink-0"
      >
        <TabList
          type="button-gray"
          size="sm"
          aria-label={m.activity_inbox_filter_label()}
          className="@max-[22rem]/tabbed-header:gap-1 @max-[22rem]/tabbed-header:*:px-1.5 @max-[22rem]/tabbed-header:*:text-sm"
        >
          {FILTER_TABS.map((tab) => (
            <Tab
              key={tab.id}
              id={tab.id}
              className={({ isSelected }) =>
                cn(
                  "gap-1.5 font-medium",
                  isSelected
                    ? cn("text-primary", indicator.visible && "bg-transparent")
                    : "text-tertiary",
                )
              }
              onPointerEnter={() => onFilterIntent?.(tab.id)}
              onFocus={() => onFilterIntent?.(tab.id)}
            >
              {() => {
                const count = counts[tab.id] ?? 0;
                return (
                  <>
                    {tab.label()}
                    {count > 0 && (
                      <span dir="ltr" className="text-xs font-normal text-quaternary tabular-nums">
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </>
                );
              }}
            </Tab>
          ))}
        </TabList>
      </Tabs>
    </div>
  );
}
