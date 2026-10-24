import { useMemo } from "react";
import { useSelector } from "@tanstack/react-store";

import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";

import { AgentMascotView } from "./agent-mascot-view";
import { replyingAgentIds } from "./reply-intents";
import { useReplyIntentStore } from "./reply-intents-context";
import { MAX_REPLYING_FACES, replyingAgentsAmong, replyingNames } from "./replying-agents-summary";
import { useLiveAgents } from "./workspace-agents-realtime";
import "./replying-agents-line.css";

/** Agent ids never contain a comma, so a place's Agents travel as one comparable string. */
const ID_SEPARATOR = ",";

/**
 * The line at the foot of a conversation pane saying which Agents are about to post in this place:
 * the open conversation's top level, or the open thread (`threadRootId`). Everyone who can read the
 * place sees it, whether or not they can write there. It renders nothing while nobody is replying
 * or Live agent activity is off, and does not read the roster then. An Agent's message arriving in
 * the place ends its entry there (`useEndReplyIntentsOnArrival`).
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
  const replyingIds = useReplyingAgentIds(conversationId, threadRootId);
  return replyingIds ? (
    <ReplyingAgents replyingIds={replyingIds} sentence="typing" className={className} />
  ) : null;
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
  return replyingIds ? (
    <ReplyingAgents replyingIds={replyingIds} sentence="replying" className="mt-1.5" />
  ) : null;
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

/**
 * Up to three mascots overlap, moving as they do elsewhere, and one sentence names everyone. The
 * mascots are decorative; the sentence is a polite status for screen readers.
 */
function ReplyingAgents({
  replyingIds,
  sentence: kind,
  className,
}: {
  replyingIds: string;
  sentence: keyof typeof SENTENCES;
  className?: string;
}) {
  const roster = useLiveAgents();
  const replying = useMemo(
    () => replyingAgentsAmong(roster, replyingIds.split(ID_SEPARATOR)),
    [roster, replyingIds],
  );
  if (replying.length === 0) return null;
  // The wording comes from the messages and locale at render, so a locale change shows at once.
  const names = replyingNames(
    replying.map((agent) => agent.name),
    getLocale(),
  );
  const messages = SENTENCES[kind];
  const sentence =
    names.kind === "overflow"
      ? messages.overflow(names)
      : names.plural
        ? messages.many({ names: names.text })
        : messages.one({ names: names.text });
  return (
    <div className={cx("replying-line flex min-h-6 items-center gap-2 px-1 text-xs", className)}>
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {replying.slice(0, MAX_REPLYING_FACES).map((agent, index) => (
          <AvatarSticker key={agent.id} size="xs" className={index > 0 ? "-ml-2" : undefined}>
            <AgentMascotView mascot={agent.mascot} activity="working" />
          </AvatarSticker>
        ))}
      </span>
      <p role="status" className="min-w-0 truncate text-tertiary">
        {sentence}
      </p>
    </div>
  );
}
