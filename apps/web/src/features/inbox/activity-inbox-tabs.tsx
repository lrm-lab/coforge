import { AtSign, Inbox01, Mail01 } from "@untitledui/icons";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

const FILTER_TABS: ReadonlyArray<{
  id: ActivityInboxFilter;
  icon: typeof Inbox01;
  label: () => string;
}> = [
  { id: "all", icon: Inbox01, label: () => m.activity_inbox_filter_all() },
  { id: "unread", icon: Mail01, label: () => m.activity_inbox_filter_unread() },
  { id: "mentions", icon: AtSign, label: () => m.activity_inbox_filter_mentions() },
];

/**
 * All / Unread / Mentions as the Chat header's icon + label underline tabs. Unread and Mentions
 * carry how many rows have something unread and an unread mention; the numbers are the same
 * whichever tab is showing, and a zero shows nothing.
 */
export function ActivityInboxTabs({
  filter,
  onFilterChange,
  counts,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
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
      {/* In a list column dragged narrow the tabs drop their icons, so the three still fit. */}
      <TabList
        type="underline"
        size="md"
        aria-label={m.activity_inbox_filter_label()}
        className="@max-[22rem]/tabbed-header:**:data-icon:hidden"
      >
        {FILTER_TABS.map((tab) => (
          <Tab key={tab.id} id={tab.id} icon={tab.icon}>
            {/* The official `badge` prop hides below `md`; the count must show on phones too. */}
            {({ isSelected, isHovered }) => {
              const count = counts[tab.id] ?? 0;
              return (
                <>
                  {tab.label()}
                  {count > 0 && (
                    <Badge
                      type="pill-color"
                      size="sm"
                      color={isSelected || isHovered ? "brand" : "gray"}
                      className="transition-inherit-all"
                    >
                      {count > 99 ? "99+" : count}
                    </Badge>
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
