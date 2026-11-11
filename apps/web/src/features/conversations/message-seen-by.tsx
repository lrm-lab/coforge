import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SubmenuTrigger } from "react-aria-components";
import { Check, ChevronDown, ChevronUp } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { formatMomentForDisplay } from "#src/lib/dates";
import { cn } from "#src/lib/utils";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { MemberDirectory, useMemberDirectory } from "./member-directory";
import { mentionKey, type Mentionable } from "./mention-text";
import { loadMessageSeenBy } from "./message-seen-by.functions";

/**
 * Who has seen one of the viewer's messages (Telegram's "N Seen"): the members whose read position
 * reached it, asked for only when the menu opens. Names and faces come from the conversation's own
 * member directory (`SeenByDirectory`), so the answer itself carries ids only. In a direct message
 * the answer says when instead (Telegram's "read at"): the other side is the only reader, so the
 * row gives the time and no name. A message read before read times were kept has none, and keeps
 * the count. In a channel the list also names each Agent the message never reached, with why
 * (it muted the channel, or unfollowed the thread), so nobody waits on an Agent that did not get it.
 */
export const SeenByDirectory = MemberDirectory;

type Reader = Pick<Mentionable, "kind" | "id" | "label" | "avatarUrl">;
type Undelivered = {
  agent: Reader;
  reason: Awaited<ReturnType<typeof loadMessageSeenBy>>["undeliveredAgents"][number]["reason"];
};

/** The message's readers, resolved against the directory at render (the query caches ids only,
 * so a directory that fills in later still names them); one the directory does not hold (they have
 * since left, or joined after the page was read) is counted but not listed. */
function useSeenBy(conversationId: string, messageId: string, enabled: boolean) {
  const directory = useMemberDirectory();
  const load = useServerFn(loadMessageSeenBy);
  const { data } = useQuery({
    queryKey: ["conversation", "seen-by", conversationId, messageId],
    queryFn: () => load({ data: { conversationId, messageId } }),
    enabled,
    staleTime: 10_000,
  });
  return useMemo(() => {
    if (!data) return undefined;
    const { seen, seenAt, undeliveredAgents } = data;
    const members = new Map(directory?.map((member) => [mentionKey(member), member]));
    const readers = seen.flatMap((reader): Reader[] => {
      const member = members.get(mentionKey(reader));
      return member ? [member] : [];
    });
    // Only an Agent the viewer can name is listed: a blocker is no use without a face and a name.
    const undelivered = undeliveredAgents.flatMap(({ id, reason }): Undelivered[] => {
      const agent = members.get(mentionKey({ kind: "agent", id }));
      return agent ? [{ agent, reason }] : [];
    });
    // Counted like the ticks count them, even a reader the directory cannot name yet.
    return { readers, undelivered, count: seen.length, seenAt };
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
    <ActorAvatar
      presence={false}
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

/** Why an Agent missed the message; a reason the server adds later fails the typecheck here. */
function undeliveredReason(reason: Undelivered["reason"]) {
  switch (reason) {
    case "channel_muted":
      return m.conversation_seen_undelivered_muted();
    case "thread_unfollowed":
      return m.conversation_seen_undelivered_unfollowed();
    default:
      return reason satisfies never;
  }
}

/** A row's face and name, and for an Agent that did not get the message, why under the name. */
function ListedMember({
  reader,
  reason,
  size,
}: {
  reader: Reader;
  reason?: Undelivered["reason"];
  size?: "xs" | "sm";
}) {
  return (
    <span className={cn("flex min-w-0 items-center", size === "sm" ? "gap-3" : "gap-2")}>
      <ReaderAvatar reader={reader} size={size} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{reader.label}</span>
        {reason && (
          <span className="text-xs whitespace-normal text-tertiary">
            {undeliveredReason(reason)}
          </span>
        )}
      </span>
    </span>
  );
}

/** The entry's own label: the read count, and under it how many Agents the message missed. */
function SeenSummary({ count, undelivered }: { count?: number; undelivered: number }) {
  return (
    <span className="flex min-w-0 grow flex-col text-left">
      <span className="truncate">{seenLabel(count)}</span>
      {undelivered > 0 && (
        <span className="text-xs font-normal text-tertiary">
          {m.conversation_seen_undelivered({ count: undelivered })}
        </span>
      )}
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
  const readers = seen?.readers ?? [];
  const undelivered = seen?.undelivered ?? [];
  const seenAt = useSeenAtLabel(seen?.seenAt);
  return seenAt ? (
    <Dropdown.Item icon={SeenIcon} label={seenAt} />
  ) : readers.length || undelivered.length ? (
    <SubmenuTrigger>
      <Dropdown.Item textValue={seenLabel(seen?.count)} icon={SeenIcon}>
        <span className="flex items-center">
          <SeenSummary count={seen?.count} undelivered={undelivered.length} />
          <ReaderFaces readers={readers} />
        </span>
      </Dropdown.Item>
      <Dropdown.SubmenuPopover className="w-64">
        <Dropdown.Menu aria-label={m.conversation_seen_by()} className="max-h-80">
          {readers.map((reader) => (
            <Dropdown.Item
              key={mentionKey(reader)}
              id={mentionKey(reader)}
              textValue={reader.label}
            >
              <ListedMember reader={reader} />
            </Dropdown.Item>
          ))}
          {readers.length > 0 && undelivered.length > 0 && <Dropdown.Separator />}
          {undelivered.map(({ agent, reason }) => (
            <Dropdown.Item
              key={mentionKey(agent)}
              id={mentionKey(agent)}
              textValue={`${agent.label} ${undeliveredReason(reason)}`}
            >
              <ListedMember reader={agent} reason={reason} />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.SubmenuPopover>
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
  const readers = seen?.readers ?? [];
  const undelivered = seen?.undelivered ?? [];
  const seenAt = useSeenAtLabel(seen?.seenAt);
  const listed = !seenAt && readers.length + undelivered.length > 0;
  return (
    <>
      <Button
        color="tertiary"
        size="md"
        noTextPadding
        isDisabled={!seenAt && !listed}
        aria-expanded={listed ? expanded : undefined}
        onPress={() => setExpanded((value) => !value)}
        className="w-full justify-start rounded-lg py-3 [&>[data-text]]:flex [&>[data-text]]:flex-1 [&>[data-text]]:items-center"
      >
        <SeenIcon large />
        {seenAt ? (
          <span className="grow text-left">{seenAt}</span>
        ) : (
          <SeenSummary count={seen?.count} undelivered={undelivered.length} />
        )}
        {listed ? (
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
      {listed && expanded ? (
        <ul
          aria-label={m.conversation_seen_by()}
          className="flex max-h-60 flex-col overflow-y-auto"
        >
          {readers.map((reader) => (
            <li key={mentionKey(reader)} className="rounded-lg px-1 py-2 text-md text-secondary">
              <ListedMember reader={reader} size="sm" />
            </li>
          ))}
          {readers.length > 0 && undelivered.length > 0 && (
            <li aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
          )}
          {undelivered.map(({ agent, reason }) => (
            <li key={mentionKey(agent)} className="rounded-lg px-1 py-2 text-md text-secondary">
              <ListedMember reader={agent} reason={reason} size="sm" />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
