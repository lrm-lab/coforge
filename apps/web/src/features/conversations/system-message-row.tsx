import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { clockLabel } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { DayDivider, UnreadDivider } from "./message-dividers";
import { ROW_CLASS, type MessageView } from "./message-row";

/**
 * A system message (task/membership notices, etc.) is not a person talking: it carries no avatar
 * and no sender heading, and renders as a compact, muted line of plain text in the stream — like
 * Slack's channel notices. It still carries the unread divider and the jump highlight, since the
 * unread run can begin at a notice and a jump can land on one. The wrapper (`li`) is
 * `MessageRow`'s, so a system row costs the browser exactly what a normal one does. A run of two
 * or more notices is folded into one summary line by `SystemMessageGroup`, which renders these
 * rows when opened.
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
  return (
    <li data-message-id={message.id} className={ROW_CLASS}>
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
      <div
        id={`message-${message.id}`}
        data-message="system"
        data-scroll-anchor
        className={cn(
          "group/message flex scroll-m-6 items-baseline gap-2 px-4 py-1 text-xs text-tertiary transition-[background-color,box-shadow] duration-500 target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:px-6",
          highlighted && "bg-tertiary ring-2 ring-brand/50 ring-offset-4 ring-offset-primary",
        )}
      >
        {/* System bodies are short plain text (task/membership notices, authored with a plain
            `@handle`, not a mention token), so they render as a single muted line rather than
            full Markdown. One line, never wrapped: overflow becomes an ellipsis, which lands in a
            task's title since its number comes first. The span is a flex item with min-w-0, so
            `truncate` collapses against the hover timestamp and works. */}
        {/* The tooltip wraps the span itself: our `Tooltip` already renders RAC's
            `TooltipTrigger` around its child, and the wrapper version put a `<button>` between
            the flex row and this span — so the span's `min-w-0 flex-1` stopped governing the
            row, the row grew past the container, and the whole stream scrolled sideways on a
            phone. As a direct child the span is the flex item again, so `truncate` clips. */}
        <Tooltip title={message.body}>
          <span className="min-w-0 flex-1 truncate">{message.body}</span>
        </Tooltip>
        {/* Shown on hover, so a touch screen, which cannot hover, leaves its width to the
            notice. */}
        <time
          dateTime={new Date(message.createdAt).toISOString()}
          className="shrink-0 tabular-nums opacity-0 group-hover/message:opacity-100 pointer-coarse:hidden"
        >
          {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
        </time>
      </div>
    </li>
  );
}
