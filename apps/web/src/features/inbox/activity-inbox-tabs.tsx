import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
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
];

/**
 * All / Unread / Mentions as quiet pills, Linear's: the open one on a soft grey fill. Unread
 * and Mentions carry how many rows have something unread and an unread mention as a small muted
 * number; the numbers are the same whichever tab is showing, and a zero shows nothing.
 */
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
  return (
    <Tabs
      selectedKey={filter}
      onSelectionChange={(key) => {
        const next = FILTER_TABS.find((tab) => tab.id === key);
        if (next) onFilterChange(next.id);
      }}
      className="w-max shrink-0"
    >
      {/* In a list column dragged narrow the tabs sit closer and step down a size, so the three
          still fit (English "Mentions" included). */}
      <TabList
        type="button-gray"
        size="sm"
        aria-label={m.activity_inbox_filter_label()}
        className="@max-[22rem]/tabbed-header:gap-2 @max-[22rem]/tabbed-header:*:text-sm"
      >
        {FILTER_TABS.map((tab) => (
          <Tab
            key={tab.id}
            id={tab.id}
            // Linear's filter pills (Frank, 11-09): the open one a soft grey fill in primary text.
            className={({ isSelected }) =>
              cn("gap-1.5 font-medium", isSelected ? "text-primary" : "text-tertiary")
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
                    <span className="text-xs font-normal text-quaternary tabular-nums">
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
  );
}
