import { useMemo } from "react";
import { useSelector } from "@tanstack/react-store";

import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

import { AgentMascotView } from "./agent-mascot-view";
import { useEndWhenAgentPosts, type ShownMessage } from "./agent-post-clearing";
import { replyingAgentIds } from "./reply-intents";
import { useReplyIntentStore } from "./reply-intents-context";
import { MAX_REPLYING_FACES, replyingAgentsAmong, replyingNames } from "./replying-agents-summary";
import { useLiveAgents } from "./workspace-agents-realtime";
import "./replying-agents-line.css";

/** Agent ids never contain a comma, so a place's Agents travel as one comparable string. */
const ID_SEPARATOR = ",";

/**
 * The line above a composer saying which Agents are about to post in this place: the open
 * conversation's top level, or the open thread (`threadRootId`). It renders nothing while nobody
 * is replying, and does not read the roster then. An Agent's message arriving in the place ends
 * its entry there (`useEndWhenAgentPosts`).
 */
export function ReplyingAgentsLine({
  conversation,
  root,
}: {
  /** The conversation pane's view: its id, and the messages shown in this place. */
  conversation: { conversationId: string; messages: readonly ShownMessage[] };
  /** The open thread's root; absent at the conversation's top level. */
  root?: { id: string };
}) {
  const { conversationId, messages } = conversation;
  const threadRootId = root?.id ?? null;
  const intents = useReplyIntentStore();
  useEndWhenAgentPosts(conversationId, threadRootId, messages);
  // Only this place's Agents, as one string: an entry elsewhere re-renders nothing here.
  const replyingIds = useSelector(intents.store, (entries) =>
    replyingAgentIds(entries, conversationId, threadRootId).join(ID_SEPARATOR),
  );
  return replyingIds ? <ReplyingAgents replyingIds={replyingIds} /> : null;
}

/**
 * Up to three mascots overlap, moving as they do elsewhere, and one sentence names everyone
 * (`agent_replying_*` messages). It holds its own row in the layout, so the last message
 * is never covered. Decorative mascots, plain text: a name appearing and vanishing is not worth
 * announcing.
 */
function ReplyingAgents({ replyingIds }: { replyingIds: string }) {
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
  const sentence =
    names.kind === "overflow"
      ? m.agent_replying_overflow(names)
      : names.plural
        ? m.agent_replying_many({ names: names.text })
        : m.agent_replying_one({ names: names.text });
  return (
    <div className="replying-line mx-4 mt-2 -mb-1 flex min-h-6 items-center gap-2 px-1 text-xs md:mx-6">
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {replying.slice(0, MAX_REPLYING_FACES).map((agent, index) => (
          <AvatarSticker key={agent.id} size="xs" className={index > 0 ? "-ml-2" : undefined}>
            <AgentMascotView mascot={agent.mascot} activity="working" />
          </AvatarSticker>
        ))}
      </span>
      <p className="min-w-0 truncate text-tertiary">{sentence}</p>
    </div>
  );
}
