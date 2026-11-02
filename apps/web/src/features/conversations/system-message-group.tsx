import { memo, type ReactNode } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CentredOnRule, DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import {
  summarizeSystemGroup,
  type SystemGroupSummary,
  type SystemMessageKind,
} from "./system-message-groups";
import { SystemGroupDayContext } from "./system-message-row";

function partLabel(kind: SystemMessageKind, count: number): string {
  if (kind === "taskUpdate") return m.conversation_system_group_task_updates({ count });
  return m.conversation_system_group_messages({ count });
}

/** "There are 2 task updates", or "There are 6 system updates: 5 task updates, 1 system message". */
function summaryLabel({ total, parts }: SystemGroupSummary): string {
  const labels = parts.map((part) => partLabel(part.kind, part.count));
  if (labels.length === 1)
    return m.conversation_system_group_one_part({ count: total, part: labels[0]! });
  const joined = labels.join(m.conversation_system_group_separator());
  return parts.some((part) => part.kind === "system")
    ? m.conversation_system_group_mixed({ count: total, parts: joined })
    : m.conversation_system_group_parts({ parts: joined });
}

/**
 * A run of consecutive system messages folded into one summary line centred on a hairline, as
 * Raft's is, collapsed by default. Opening it shows the notices themselves (`children`, ordinary
 * system rows) beneath the line. A run can span days; it is drawn under its first notice's day
 * (`SystemGroupDayContext`). The group's row carries its first message's id, so opening the
 * conversation on that message (the unread boundary starts a group, never falls inside one) and
 * keeping the reading position across a history load both find it like any other row. Memoized like `MessageRow`: a
 * folded group renders again only when its messages or its dividers change.
 */
export const SystemMessageGroup = memo(function SystemMessageGroup({
  id,
  messages,
  expanded,
  onToggleExpanded,
  dayChanged,
  unreadStartsHere,
  dateLocale,
  children,
}: {
  id: string;
  messages: readonly { id: string; body: string; createdAt: Date | string }[];
  expanded: boolean;
  /** Called with this group's messages, so one stable handler serves every group. */
  onToggleExpanded: (messages: readonly { id: string }[]) => void;
  dayChanged: boolean;
  unreadStartsHere: boolean;
  dateLocale?: string;
  /** The grouped rows, rendered only while the group is open. */
  children: ReactNode;
}) {
  const first = messages[0]!;
  const timeZone = useTimeZone();
  const listId = `${id}:messages`;
  return (
    <li
      data-message-id={first.id}
      data-system-group={id}
      // Every notice the group folds, for the scroll anchor that keeps the reading position when
      // older history extends the group (`restoreScrollAnchor`).
      data-system-group-members={messages.map((message) => message.id).join(" ")}
      className="flex flex-col"
    >
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={first.createdAt} locale={dateLocale} />}
      {/* The summary is what the reader sees of a folded group: the scroll anchor holds it. */}
      <div data-scroll-anchor className="flex items-center gap-2 px-4 py-1 md:px-6">
        <CentredOnRule>
          <Button
            color="link-gray"
            size="sm"
            className="min-w-0 text-xs font-medium *:data-text:min-w-0 *:data-text:truncate"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onPress={() => onToggleExpanded(messages)}
            iconTrailing={
              <ChevronDown
                aria-hidden="true"
                className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
              />
            }
          >
            {summaryLabel(summarizeSystemGroup(messages))}
          </Button>
        </CentredOnRule>
      </div>
      {expanded && (
        <SystemGroupDayContext
          value={dateLocale && dayLabel(first.createdAt, dateLocale, timeZone)}
        >
          <ol id={listId} className="flex flex-col">
            {children}
          </ol>
        </SystemGroupDayContext>
      )}
    </li>
  );
});
