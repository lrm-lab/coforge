import { createContext, useContext } from "react";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { clockLabel, formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { ActorName, type NamedActor } from "#src/features/avatars/actor-name";
import { cn } from "#src/lib/utils";
import { CentredOnRule, DayDivider, UnreadDivider, dayLabel } from "./message-dividers";
import { ROW_CLASS } from "./message-row";
import type { MessageView } from "./message-view";
import { useMemberDirectory } from "./member-directory";
import type { Mentionable } from "./mention-text";
import { systemNoticeParts, systemNoticeText, type NoticePerson } from "./system-notice-text";

/** The day label (`dayLabel`) of the day a folded group is drawn under, its first notice's, so a
 * notice from a later day in it writes its date before its time. Outside a group a notice is under
 * its own day's divider. */
export const SystemGroupDayContext = createContext<string | undefined>(undefined);

/**
 * A system message (task/membership notices, etc.) is not a person talking: it carries no sender
 * avatar and no heading, and renders as one muted line centred on a hairline, its time first, as
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
  // In the viewer's language from the notice's kind; an unstructured one reads as its body. The
  // line draws each person it names by face (task #521); the tooltip keeps the words alone.
  const text = systemNoticeText(message);
  const parts = systemNoticeParts(message);
  const members = useMemberDirectory();
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
            {/* The trigger is itself the flex item, so `min-w-0` governs it and `truncate` clips;
                a wrapper between this line and the text let the stream scroll sideways on a
                phone. A plain span gives React Aria nothing to hover, so the full text never
                showed. Out of the tab order, as in `agent-model-label.tsx`: a stop per notice
                would crowd the stream, and the text is read whole whatever the width cuts. */}
            <Tooltip title={text}>
              <TooltipTrigger
                excludeFromTabOrder
                className="min-w-0 cursor-default truncate rounded-sm text-left outline-focus-ring focus-visible:outline-2"
              >
                {parts.map((part, index) =>
                  typeof part === "string" ? (
                    part
                  ) : (
                    <ActorName key={index} actor={noticeActor(part, members)} />
                  ),
                )}
              </TooltipTrigger>
            </Tooltip>
          </span>
        </CentredOnRule>
      </div>
    </li>
  );
}

/** A person a notice names, by the face the conversation's members give them; one who has since
 * left keeps a face drawn from their name. The name is the notice's own words for them. */
function noticeActor(
  { person, text }: NoticePerson,
  members: readonly Mentionable[] | undefined,
): NamedActor {
  const member = members?.find(
    (candidate) =>
      candidate.handle === person.handle && (!person.kind || candidate.kind === person.kind),
  );
  return member
    ? { kind: member.kind, id: member.id, name: text, avatarUrl: member.avatarUrl }
    : { kind: person.kind === "agent" ? "agent" : "user", name: text };
}
