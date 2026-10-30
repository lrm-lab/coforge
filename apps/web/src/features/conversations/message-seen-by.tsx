import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SubmenuTrigger } from "react-aria-components";
import { Check, ChevronDown, ChevronUp } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { formatMomentForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { mentionKey, type Mentionable } from "./mention-text";
import { loadMessageSeenBy } from "./message-seen-by.functions";

/**
 * Who has seen one of the viewer's messages (Telegram's "N Seen"): the members whose read position
 * reached it, asked for only when the menu opens. Names and faces come from the conversation's own
 * member directory (`SeenByDirectory`), so the answer itself carries ids only. In a direct message
 * the answer says when instead (Telegram's "read at"): the other side is the only reader, so the
 * row gives the time and no name. A message read before read times were kept has none, and keeps
 * the count.
 */
const SeenByDirectoryContext = createContext<readonly Mentionable[] | undefined>(undefined);

/** The conversation's members, which a seen-by list names its readers from. */
export function SeenByDirectory({
  members,
  children,
}: {
  members?: readonly Mentionable[];
  children: ReactNode;
}) {
  return <SeenByDirectoryContext value={members}>{children}</SeenByDirectoryContext>;
}

type Reader = Pick<Mentionable, "kind" | "id" | "label" | "avatarUrl">;

/** The message's readers, resolved against the directory at render (the query caches ids only,
 * so a directory that fills in later still names them); one the directory does not hold (they have
 * since left, or joined after the page was read) is counted but not listed. */
function useSeenBy(conversationId: string, messageId: string, enabled: boolean) {
  const directory = useContext(SeenByDirectoryContext);
  const load = useServerFn(loadMessageSeenBy);
  const { data } = useQuery({
    queryKey: ["conversation", "seen-by", conversationId, messageId],
    queryFn: () => load({ data: { conversationId, messageId } }),
    enabled,
    staleTime: 10_000,
  });
  return useMemo(() => {
    if (!data) return undefined;
    const { seen, seenAt } = data;
    const members = new Map(directory?.map((member) => [mentionKey(member), member]));
    const readers = seen.flatMap((reader): Reader[] => {
      const member = members.get(mentionKey(reader));
      return member ? [member] : [];
    });
    // Counted like the ticks count them, even a reader the directory cannot name yet.
    return { readers, count: seen.length, seenAt };
  }, [data, directory]);
}

/** When the other side of a direct message read it, in the viewer's own zone and clock. */
function useSeenAtLabel(seenAt: string | undefined) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return seenAt && formatMomentForDisplay(seenAt, timeZone, getLocale(), timeFormat);
}

/** Two overlapping checks, the read ticks' mark (`ReadTicks`), as a menu row's icon. */
const SeenIcon = ({ large = false }: { large?: boolean; className?: string }) => (
  <span aria-hidden="true" className="mr-2 flex shrink-0 items-center text-fg-quaternary">
    <Check className={large ? "size-5" : "size-4"} />
    <Check className={large ? "-ml-3 size-5" : "-ml-2.5 size-4"} />
  </span>
);

function ReaderAvatar({ reader, size = "xs" }: { reader: Reader; size?: "xs" | "sm" }) {
  return reader.kind === "agent" ? (
    <AgentDisplayAvatar
      agentId={reader.id}
      name={reader.label}
      src={reader.avatarUrl}
      size={size}
      cornerDot={false}
    />
  ) : (
    <IdentityAvatar
      size={size}
      src={reader.avatarUrl ?? undefined}
      userId={reader.id}
      name={reader.label}
    />
  );
}

/** The first few readers' faces, overlapping, after the count. */
function ReaderFaces({ readers }: { readers: readonly Reader[] }) {
  return (
    <span aria-hidden="true" className="ml-2 flex shrink-0 -space-x-1.5">
      {readers.slice(0, 3).map((reader) => (
        <span key={mentionKey(reader)} className="rounded-full ring-2 ring-bg-primary">
          <ReaderAvatar reader={reader} />
        </span>
      ))}
    </span>
  );
}

const seenLabel = (count: number | undefined) =>
  count === undefined
    ? m.conversation_seen_loading()
    : count === 0
      ? m.conversation_seen_none()
      : m.conversation_seen_count({ count: String(count) });

/**
 * The "N seen" entry of the hover toolbar's "…" menu on an own message, which opens the list of
 * readers. Read when the menu opens.
 */
export function MessageSeenByMenuEntry({
  conversationId,
  messageId,
  menuOpen,
}: {
  conversationId: string;
  messageId: string;
  menuOpen: boolean;
}) {
  const seen = useSeenBy(conversationId, messageId, menuOpen);
  const readers = seen?.readers;
  const seenAt = useSeenAtLabel(seen?.seenAt);
  return seenAt ? (
    <Dropdown.Item icon={SeenIcon} label={seenAt} />
  ) : readers?.length ? (
    <SubmenuTrigger>
      <Dropdown.Item textValue={seenLabel(seen?.count)} icon={SeenIcon}>
        <span className="flex items-center">
          <span className="grow truncate">{seenLabel(seen?.count)}</span>
          <ReaderFaces readers={readers} />
        </span>
      </Dropdown.Item>
      <Dropdown.Popover placement="end top" className="w-56">
        <Dropdown.Menu aria-label={m.conversation_seen_by()} className="max-h-80">
          {readers.map((reader) => (
            <Dropdown.Item
              key={mentionKey(reader)}
              id={mentionKey(reader)}
              textValue={reader.label}
            >
              <span className="flex items-center gap-2">
                <ReaderAvatar reader={reader} />
                <span className="truncate">{reader.label}</span>
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </SubmenuTrigger>
  ) : (
    <Dropdown.Item isDisabled icon={SeenIcon} label={seenLabel(seen?.count)} />
  );
}

/**
 * The action sheet's counterpart on a phone: the same "N seen" row, which unfolds the readers
 * under it. Read when the sheet opens.
 */
export function MessageSeenBySheetEntry({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const seen = useSeenBy(conversationId, messageId, true);
  const readers = seen?.readers;
  const seenAt = useSeenAtLabel(seen?.seenAt);
  return (
    <>
      <Button
        color="tertiary"
        size="md"
        noTextPadding
        isDisabled={!seenAt && !readers?.length}
        aria-expanded={!seenAt && readers?.length ? expanded : undefined}
        onPress={() => setExpanded((value) => !value)}
        className="w-full justify-start rounded-lg py-3 [&>[data-text]]:flex [&>[data-text]]:flex-1 [&>[data-text]]:items-center"
      >
        <SeenIcon large />
        <span className="grow text-left">{seenAt || seenLabel(seen?.count)}</span>
        {!seenAt && readers?.length ? (
          <>
            <ReaderFaces readers={readers} />
            {expanded ? (
              <ChevronUp aria-hidden="true" className="ml-2 size-5 text-fg-quaternary" />
            ) : (
              <ChevronDown aria-hidden="true" className="ml-2 size-5 text-fg-quaternary" />
            )}
          </>
        ) : null}
      </Button>
      {!seenAt && expanded && readers?.length ? (
        <ul
          aria-label={m.conversation_seen_by()}
          className="flex max-h-60 flex-col overflow-y-auto"
        >
          {readers.map((reader) => (
            <li
              key={mentionKey(reader)}
              className="flex items-center gap-3 rounded-lg px-1 py-2 text-md text-secondary"
            >
              <ReaderAvatar reader={reader} size="sm" />
              <span className="truncate">{reader.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
