import { useEffect, useMemo, useState } from "react";
import { DialogTrigger as AriaDialogTrigger } from "react-aria-components";
import { useSelector } from "@tanstack/react-store";

import { Button } from "#src/components/base/buttons/button";
import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";

import { activitySentenceLabel } from "./agent-activity-presentation";
import { AgentListPopover, AgentListRow, AgentListRows } from "./agent-list-popover";
import { AgentMascotView } from "./agent-mascot-view";
import { agentDisplay } from "./agent-status-display";
import { pickBusyAgents } from "./busy-agents";
import { useChannelAgents } from "./channel-agents-context";
import type { OpenAgentProfile } from "./profile-panel/open-agent-profile";
import { replyingAgentIds } from "./reply-intents";
import { useReplyIntentStore } from "./reply-intents-context";
import {
  agentsLineSummary,
  replyingAgentsAmong,
  replyingNames,
  type ReplyingAgent,
} from "./replying-agents-summary";
import { useConversationReplyIntents } from "./reply-intents-realtime";
import {
  useCurrentWorkspaceId,
  useLiveAgent,
  useLiveWorkspaceAgents,
  useVisibleLiveAgents,
} from "./workspace-agents-realtime";
import "./replying-agents-line.css";

/** Agent ids never contain a comma, so a place's Agents travel as one comparable string. */
const ID_SEPARATOR = ",";
/** Nor a bar: the typing and the working Agents of one line, as one comparable string. */
const GROUP_SEPARATOR = "|";

const idsOf = (joined: string) => (joined ? joined.split(ID_SEPARATOR) : []);

const PILL_CLASS =
  "h-8 max-w-full rounded-full border border-secondary bg-primary pr-3 pl-1.5 text-xs text-tertiary shadow-xs";

/**
 * The line at the foot of a conversation pane: which Agents are about to post in this place (the
 * open conversation's top level, or the open thread, `threadRootId`) and, in a channel's main
 * stream (`useChannelAgents`), which of the channel's Agents are working anywhere. Everyone who can
 * read the place sees who is typing, whether or not they can write there. It renders nothing while
 * nobody is typing or working or Live agent activity is off, and does not read the Agents then. An
 * Agent's message arriving in the place ends its entry there (`useEndReplyIntentsOnArrival`).
 */
export function ReplyingAgentsLine({
  conversationId,
  threadRootId,
  className,
}: {
  conversationId: string;
  /** The open thread's root; null at the conversation's top level. */
  threadRootId: string | null;
  className?: string;
}) {
  useConversationReplyIntents(useCurrentWorkspaceId(), conversationId);
  const channel = useChannelAgents(conversationId, threadRootId);
  const typingIds = useReplyingAgentIds(conversationId, threadRootId);
  const workingIds = useWorkingAgentIds(channel?.agentIds);
  const current = typingIds || workingIds ? `${typingIds}${GROUP_SEPARATOR}${workingIds}` : "";
  // The pill eases out naming the Agents it last named and unmounts when that animation ends;
  // with reduced motion there is none, so it goes at once.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const leaving = !current && shown !== "";
  useEffect(() => {
    if (leaving && window.matchMedia("(prefers-reduced-motion: reduce)").matches) setShown("");
  }, [leaving]);
  const [shownTyping = "", shownWorking = ""] = shown.split(GROUP_SEPARATOR);
  return (
    <div className={className}>
      {shown && (
        <ComposerAgentsPill
          typingIds={shownTyping}
          workingIds={shownWorking}
          listsAgents={channel !== undefined}
          onOpenAgentProfile={channel?.onOpenAgentProfile}
          leaving={leaving}
          onLeft={() => setShown("")}
        />
      )}
    </div>
  );
}

/** The line under a root in the conversation's stream saying which Agents are about to reply in
 * its thread. */
export function ThreadReplyingLine({
  conversationId,
  rootId,
}: {
  conversationId: string;
  rootId: string;
}) {
  const replyingIds = useReplyingAgentIds(conversationId, rootId);
  return replyingIds ? <ThreadReplyingAgents replyingIds={replyingIds} /> : null;
}

/** The Agents replying in one place, as one string (an entry elsewhere re-renders nothing here),
 * or "" while nobody is or Live agent activity is off. */
function useReplyingAgentIds(conversationId: string, threadRootId: string | null) {
  const [live] = useLiveAgentActivity();
  const intents = useReplyIntentStore();
  return useSelector(intents.store, (entries) =>
    live ? replyingAgentIds(entries, conversationId, threadRootId).join(ID_SEPARATOR) : "",
  );
}

/** The channel's Agents working or thinking right now, wherever that work is, as one string; ""
 * outside a channel's main stream or while Live agent activity is off. */
function useWorkingAgentIds(channelAgentIds?: readonly string[]) {
  const [live] = useLiveAgentActivity();
  const members = useMemo(() => new Set(channelAgentIds), [channelAgentIds]);
  return useLiveWorkspaceAgents((agents) =>
    live && channelAgentIds ? pickBusyAgents(agents.filter((agent) => members.has(agent.id))) : [],
  )
    .map((agent) => agent.id)
    .join(ID_SEPARATOR);
}

const SENTENCES = {
  typing: {
    one: m.agent_replying_one,
    many: m.agent_replying_many,
    overflow: m.agent_replying_overflow,
  },
  replying: {
    one: m.agent_thread_replying_one,
    many: m.agent_thread_replying_many,
    overflow: m.agent_thread_replying_overflow,
  },
};

/** The clause naming `agents`. The wording comes from the messages and locale at render, so a
 * locale change shows at once. */
function namingClause(kind: keyof typeof SENTENCES, agents: readonly ReplyingAgent[]) {
  const names = replyingNames(
    agents.map((agent) => agent.name),
    getLocale(),
  );
  const messages = SENTENCES[kind];
  return names.kind === "overflow"
    ? messages.overflow(names)
    : names.plural
      ? messages.many({ names: names.text })
      : messages.one({ names: names.text });
}

/**
 * Up to three 16px moving mascots overlapping by 5px, each sliding and fading in over 200ms as it
 * joins, as on Raft (task #210). Decorative: the sentence beside them says who.
 */
function AgentFaces({ agents }: { agents: readonly ReplyingAgent[] }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center">
      {agents.map((agent, index) => (
        // Keyed by Agent, so one joining mounts and slides in while the others stay put.
        <AvatarSticker
          key={agent.id}
          size="xs"
          className={cx(
            "size-4 transition-[translate,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] starting:opacity-0 motion-safe:starting:-translate-x-1",
            index > 0 && "-ml-[5px]",
          )}
        >
          <AgentMascotView mascot={agent.mascot} activity="working" />
        </AvatarSticker>
      ))}
    </span>
  );
}

function ThreadReplyingAgents({ replyingIds }: { replyingIds: string }) {
  const agents = useVisibleLiveAgents();
  const replying = useMemo(
    () => replyingAgentsAmong(agents, idsOf(replyingIds)),
    [agents, replyingIds],
  );
  const summary = agentsLineSummary(replying, []);
  if (!summary) return null;
  return (
    <div className="replying-line mt-1.5 flex min-h-6 max-w-full items-center gap-1.5 px-1 text-xs">
      <AgentFaces agents={summary.faces} />
      <p role="status" className="min-w-0 truncate text-tertiary">
        {namingClause("replying", replying)}
      </p>
    </div>
  );
}

/**
 * The pill along the composer's top edge. In a channel's main stream it says who is typing and how
 * many of the channel's other Agents are working, and a press lists them all. A screen reader hears
 * who is typing, never the working count, which changes with every tool call. The status sits
 * outside `.replying-line` so that element's text stays exactly the sentence shown.
 */
function ComposerAgentsPill({
  typingIds,
  workingIds,
  listsAgents,
  onOpenAgentProfile,
  leaving,
  onLeft,
}: {
  typingIds: string;
  workingIds: string;
  listsAgents: boolean;
  onOpenAgentProfile?: OpenAgentProfile;
  leaving: boolean;
  /** Called when the pill's exit animation ends. */
  onLeft: () => void;
}) {
  const agents = useVisibleLiveAgents();
  const typing = useMemo(() => replyingAgentsAmong(agents, idsOf(typingIds)), [agents, typingIds]);
  const working = useMemo(
    () => replyingAgentsAmong(agents, idsOf(workingIds)),
    [agents, workingIds],
  );
  const summary = agentsLineSummary(typing, working);
  if (!summary) return null;
  const typingClause = typing.length > 0 ? namingClause("typing", typing) : "";
  const typingAlone = typingClause ? m.agent_typing_alone({ typing: typingClause }) : "";
  const sentence =
    summary.sentence === "typing"
      ? typingAlone
      : summary.sentence === "working"
        ? m.agent_working_here({ count: summary.others.length })
        : m.agent_typing_and_working({ typing: typingClause, others: summary.others.length });
  const content = (
    <>
      <AgentFaces agents={summary.faces} />
      <span className="min-w-0 truncate">{sentence}</span>
    </>
  );
  return (
    <>
      <span role="status" className="sr-only">
        {typingAlone}
      </span>
      <div
        data-leaving={leaving || undefined}
        onAnimationEnd={(event) => {
          if (leaving && event.target === event.currentTarget) onLeft();
        }}
        className="replying-line mb-2 inline-flex max-w-full"
      >
        {listsAgents ? (
          <AriaDialogTrigger>
            <Button
              color="tertiary"
              size="sm"
              noTextPadding
              className={cx(
                PILL_CLASS,
                "pointer-events-auto py-0 font-normal hover:bg-primary_hover hover:text-tertiary [&>[data-text]]:flex [&>[data-text]]:min-w-0 [&>[data-text]]:items-center [&>[data-text]]:gap-1.5",
              )}
            >
              {content}
            </Button>
            <AgentListPopover label={m.agent_busy_agents()} placement="top start">
              {(close) => (
                <AgentListRows>
                  {[
                    ...typing.map((agent) => ({ agent, isTyping: true })),
                    ...summary.others.map((agent) => ({ agent, isTyping: false })),
                  ].map(({ agent, isTyping }) => (
                    <AgentsLineRow
                      key={agent.id}
                      agent={agent}
                      isTyping={isTyping}
                      onOpen={
                        onOpenAgentProfile
                          ? () => {
                              close();
                              onOpenAgentProfile(agent.id);
                            }
                          : undefined
                      }
                    />
                  ))}
                </AgentListRows>
              )}
            </AgentListPopover>
          </AriaDialogTrigger>
        ) : (
          <div aria-hidden="true" className={cx(PILL_CLASS, "inline-flex items-center gap-1.5")}>
            {content}
          </div>
        )}
      </div>
    </>
  );
}

function AgentsLineRow({
  agent,
  isTyping,
  onOpen,
}: {
  agent: ReplyingAgent;
  isTyping: boolean;
  onOpen?: () => void;
}) {
  const display = useLiveAgent(agent.id)?.display;
  const caption = isTyping
    ? m.agent_typing_row()
    : display && activitySentenceLabel(agentDisplay(display).label);
  return (
    <AgentListRow
      agentId={agent.id}
      name={agent.name}
      mascot={agent.mascot}
      display={display}
      caption={caption}
      onOpenProfile={onOpen}
    />
  );
}
