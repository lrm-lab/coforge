import { useTimeZone } from "#src/lib/time-zone-context";
import { dateTimeFormat } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * The day a message was sent on, in `timeZone` (`useTimeZone`; the host's when omitted). Without a
 * `locale` it is the UTC date.
 */
export function dayLabel(value: Date | string, locale?: string, timeZone?: string): string {
  if (!locale) return new Date(value).toISOString().slice(0, 10);
  return dateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(value));
}

/**
 * A divider row: 16px between its label and the content above and below (design spec). The row
 * below a divider always starts a sender run, whose own 12px top padding plus `pb-1` makes 16px.
 * Above, a continuation or notice row ends in 4px of padding, so the divider adds 12px; a row
 * with a sender heading ends in 12px, so the divider adds 4px.
 */
const DIVIDER_ROW_CLASS =
  "message-text flex items-center gap-3 px-4 pt-3 pb-1 md:px-6 [[data-header-row]+li>&]:pt-1";

/** The "new messages" divider (Slack-style): a brand rule naming where unread begins. */
export function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label={m.conversation_unread_divider()}
      className={DIVIDER_ROW_CLASS}
    >
      {/* A neutral rule with the label at its end: the divider marks where reading resumes, so
          it has to be findable, but a coloured bar across the middle of the pane is the loudest
          thing on screen. The day divider above uses the same rule. */}
      <span aria-hidden="true" className="h-px flex-1 bg-border-secondary" />
      <span className="shrink-0 text-md text-brand-secondary">
        {m.conversation_unread_divider()}
      </span>
    </div>
  );
}

/** The date rule drawn above the first message of a day: a 22px tag with a 4px radius on a rule
 * that runs the full row and meets its border (design spec). */
export function DayDivider({ value, locale }: { value: Date | string; locale?: string }) {
  const timeZone = useTimeZone();
  return (
    <div className={cn(DIVIDER_ROW_CLASS, "gap-0")}>
      <span aria-hidden="true" className="h-px flex-1 bg-border-secondary" />
      <span className="flex h-5.5 shrink-0 items-center rounded border border-secondary bg-primary px-2 text-xs text-tertiary tabular-nums">
        {dayLabel(value, locale, timeZone)}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-secondary" />
    </div>
  );
}
