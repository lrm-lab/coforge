import { createContext, useContext } from "react";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { clockLabel, formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { CentredOnRule, DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import { ROW_CLASS } from "./message-row";
import type { MessageView } from "./message-view";
import { systemNoticeText } from "./system-notice-text";

/** The day label (`dayLabel`) of the day a folded group is drawn under, its first notice's, so a
 * notice from a later day in it writes its date before its time. Outside a group a notice is under
 * its own day's divider. */
export const SystemGroupDayContext = createContext<string | undefined>(undefined);

/**
 * A system message (task/membership notices, etc.) is not a person talking: it carries no avatar
 * and no sender heading, and renders as one muted line centred on a hairline, its time first, as
 * Raft's notices do. It still carries the unread divider and the jump highlight, since the unread
 * run can begin at a notice and a jump can land on one. The wrapper (`li`) is `MessageRow`'s, so
 * a system row costs the browser exactly what a normal one does. A run of two or more notices is
 * folded into one summary line by `SystemMessageGroup`, which renders these rows when opened.
 */
export function SystemMessageRow({
  message,
  unreadStartsHere,
  dayChanged,
  highlighted,
  dateLocale,
}: {
  message: MessageView;
  unreadStartsHere?: boolean;
  dayChanged?: boolean;
  highlighted?: boolean;
  dateLocale?: string;
}) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const groupDay = useContext(SystemGroupDayContext);
  // In the viewer's language from the notice's kind; an unstructured one reads as its body.
  const text = systemNoticeText(message);
  // A notice from a later day than its group's writes its date, before the same clock.
  const time =
    dateLocale && groupDay && groupDay !== dayLabel(message.createdAt, dateLocale, timeZone)
      ? formatMonthDayTime(message.createdAt, timeZone, dateLocale, timeFormat, { hour: "2-digit" })
      : clockLabel(message.createdAt, dateLocale, timeFormat, timeZone);
  return (
    <li data-message-id={message.id} className={ROW_CLASS}>
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
      <div
        id={`message-${message.id}`}
        data-message="system"
        data-scroll-anchor
        className={cn(
          "flex scroll-m-6 items-center gap-2 px-4 py-1 text-xs text-tertiary transition-[background-color,box-shadow] duration-500 target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:px-6",
          highlighted && "bg-tertiary ring-2 ring-brand/50 ring-offset-4 ring-offset-primary",
        )}
      >
        <CentredOnRule>
          {/* One line, never wrapped: overflow becomes an ellipsis in the notice, which lands in
              a task's title since its number comes first; the time stays whole. */}
          <span className="flex min-w-0 items-baseline gap-2">
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              className="shrink-0 tabular-nums"
            >
              {time}
            </time>
            {/* The tooltip wraps the span itself: our `Tooltip` renders RAC's `TooltipTrigger`
                around its child, and a wrapper put a `<button>` between this flex line and the
                span, so `min-w-0` stopped governing it and the stream scrolled sideways on a
                phone. As a direct child the span is the flex item, so `truncate` clips. */}
            <Tooltip title={text}>
              <span className="min-w-0 truncate">{text}</span>
            </Tooltip>
          </span>
        </CentredOnRule>
      </div>
    </li>
  );
}
