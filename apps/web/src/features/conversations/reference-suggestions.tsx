import { useEffect, useMemo, useRef } from "react";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Badge } from "#src/components/base/badges/badges";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { channelGlyph } from "./channel-name";
import { GroupAvatar } from "./group-avatar";
import { mentionKey, mentionKeysShowingHandle, type Mentionable } from "./mention-text";
import type { ChannelSuggestion, ReferenceTrigger } from "./reference-completion";
import type { ReferenceSuggestion } from "./use-reference-completion";

export function ReferenceSuggestionList({
  id,
  trigger,
  items,
  activeIndex,
  optionId,
  onChoose,
  onHighlight,
  groupBy = "membership",
  placement = "above",
}: {
  id: string;
  trigger: ReferenceTrigger;
  items: readonly ReferenceSuggestion[];
  activeIndex: number;
  optionId: (index: number) => string;
  onChoose: (item: ReferenceSuggestion) => void;
  onHighlight: (index: number) => void;
  groupBy?: "membership" | "kind";
  placement?: "above" | "inline";
}) {
  const activeOptionRef = useRef<HTMLLIElement>(null);
  const liveAgents = useLiveAgents();
  const displayByAgentId = useMemo(
    () => new Map(liveAgents.map((agent) => [agent.id, agent.display])),
    [liveAgents],
  );

  useEffect(() => {
    const option = activeOptionRef.current;
    const group = option?.closest<HTMLElement>("[role=group]");
    if (group?.querySelector("[role=option]") === option)
      group?.firstElementChild?.scrollIntoView({ block: "nearest" });
    option?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleShown = mentionKeysShowingHandle(
    items.flatMap((item) => (item.kind === "mention" ? [item.mention] : [])),
  );
  const renderOption = ({ item, index }: { item: ReferenceSuggestion; index: number }) => {
    const active = index === activeIndex;
    return (
      <li
        key={item.kind === "mention" ? mentionKey(item.mention) : `channel:${item.channel.id}`}
        ref={active ? activeOptionRef : undefined}
        id={optionId(index)}
        role="option"
        aria-selected={active}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onChoose(item);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onChoose(item);
        }}
        onMouseEnter={() => onHighlight(index)}
        className={cx(
          "flex min-h-9 cursor-pointer select-none items-center gap-2 px-3 py-1.5 pointer-coarse:min-h-11",
          active && "bg-secondary",
          item.kind === "mention" && item.mention.outsider && "*:opacity-60",
        )}
      >
        {item.kind === "mention" ? (
          <MentionRow
            mention={item.mention}
            display={displayByAgentId.get(item.mention.id)}
            showHandle={handleShown.has(mentionKey(item.mention))}
          />
        ) : (
          <ChannelRow channel={item.channel} />
        )}
      </li>
    );
  };
  const rows = items.map((item, index) => ({ item, index }));
  const isMention = (item: ReferenceSuggestion, kind: Mentionable["kind"]) =>
    item.kind === "mention" && item.mention.kind === kind;
  const split =
    groupBy === "kind"
      ? {
          first: rows.filter(({ item }) => isMention(item, "user")),
          second: rows.filter(({ item }) => isMention(item, "agent")),
          labels: [m.av_cm_mention_people(), m.av_cm_mention_agents()] as const,
        }
      : {
          first: rows.filter(({ item }) => !(item.kind === "mention" && item.mention.outsider)),
          second: rows.filter(({ item }) => item.kind === "mention" && item.mention.outsider),
          labels: [
            m.conversation_mention_group_in_channel(),
            m.conversation_mention_group_not_in_channel(),
          ] as const,
        };
  const groups =
    split.first.length && split.second.length
      ? [
          { key: "inside", label: split.labels[0], rows: split.first },
          { key: "outside", label: split.labels[1], rows: split.second },
        ]
      : [{ key: "all", label: undefined, rows }];

  return (
    <div
      role="listbox"
      id={id}
      aria-label={
        trigger === "#"
          ? m.conversation_channel_suggestions()
          : m.conversation_mention_suggestions()
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className={cx(
        "origin-bottom overflow-hidden rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt animate-in fade-in slide-in-from-bottom-1 motion-enter-sm motion-reduce:animate-none",
        placement === "above" ? "absolute inset-x-3 bottom-full z-20 mb-1" : "mt-1",
      )}
    >
      <ul
        role="presentation"
        className="scroll-fade-y max-h-[min(16rem,40svh)] overscroll-contain overflow-y-auto py-1 scroll-py-6 [touch-action:pan-y]"
      >
        {groups.map((group) =>
          group.label ? (
            <li key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
              <p
                id={`${id}-${group.key}`}
                className={cx(
                  "px-3 pt-2 pb-1 text-xs font-semibold text-tertiary",
                  group.key === "outside" && "mt-1 border-t border-secondary",
                )}
              >
                {group.label}
              </p>
              <ul role="presentation">{group.rows.map(renderOption)}</ul>
            </li>
          ) : (
            group.rows.map(renderOption)
          ),
        )}
      </ul>
    </div>
  );
}

function MentionRow({
  mention,
  display,
  showHandle,
}: {
  mention: Mentionable;
  display: AgentDisplaySnapshot | undefined;
  showHandle: boolean;
}) {
  return (
    <>
      {mention.kind === "agent" ? (
        <AgentDisplayAvatar
          agentId={mention.id}
          name={mention.label}
          src={mention.avatarUrl}
          display={display}
          size="xs"
        />
      ) : (
        <ActorAvatar
          presence
          userId={mention.id}
          size="xs"
          alt=""
          src={mention.avatarUrl}
          name={mention.label}
        />
      )}
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] items-center gap-1.5">
        <span
          className={cx(
            "truncate text-sm font-medium",
            mention.outsider ? "text-tertiary" : "text-primary",
          )}
        >
          {mention.label}
        </span>
        <Badge size="sm" color="gray" type="modern">
          {mention.kind === "agent" ? m.member_agent() : m.member_person()}
        </Badge>
        {mention.description && (
          <span className="truncate text-xs text-tertiary">{mention.description}</span>
        )}
      </span>
      {showHandle && (
        <span className="ml-auto max-w-[40%] min-w-0 truncate text-xs text-quaternary">
          @{mention.handle}
        </span>
      )}
    </>
  );
}

function ChannelRow({ channel }: { channel: ChannelSuggestion }) {
  const Glyph = channelGlyph(channel);
  return (
    <>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center">
        {channel.members?.length ? (
          <GroupAvatar members={channel.members} className="avatar-group-xs" />
        ) : (
          <Glyph className={cx("size-4", channel.archived ? "text-quaternary" : "text-tertiary")} />
        )}
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-2">
        <span
          className={cx(
            "truncate text-sm font-medium",
            channel.archived ? "text-tertiary" : "text-primary",
          )}
        >
          {channel.name}
        </span>
        {channel.description && (
          <span
            className={cx(
              "truncate text-xs",
              channel.archived ? "text-quaternary" : "text-tertiary",
            )}
          >
            {channel.description}
          </span>
        )}
      </span>
      {channel.archived && (
        <Badge size="sm" color="gray" type="modern" className="ml-auto shrink-0">
          {m.conversation_channel_archived()}
        </Badge>
      )}
    </>
  );
}
