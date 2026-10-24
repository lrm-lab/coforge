import { useEffect, useRef } from "react";

import { useReplyIntentStore } from "./reply-intents-context";

/** How recent an Agent's message must be to count as having just arrived. */
export const REPLY_INTENT_NEW_POST_MS = 60_000;

/** A message of the open place, as far as telling an Agent's new post apart needs. */
export type ShownMessage = {
  sequence: number;
  senderKind: string;
  senderAgentId?: string;
  /** The thread the message replies in; none for a top-level message. */
  threadRootId?: string;
  createdAt: Date | string;
};

/** The place a look at the messages was of, and the newest sequence it held. */
export type PostBaseline = { place: string; sequence: number };

/**
 * What a look at the messages shown in a place finds new: one Agent id per new, recent message
 * of an Agent in that place's own thread (the top level, or the open thread), and the baseline to
 * compare the next look to. The first look at a place only sets the baseline, and so does a list
 * with nothing in it, which is not a look yet: the messages that load next are not news. Only a
 * recent message is news: a page of older history loaded into the view is not.
 */
export function lookForAgentPosts(
  baseline: PostBaseline | undefined,
  place: { conversationId: string; threadRootId: string | null },
  messages: readonly ShownMessage[],
  nowMs: number,
): { agentIds: string[]; baseline: PostBaseline | undefined } {
  if (messages.length === 0) return { agentIds: [], baseline };
  const key = `${place.conversationId}:${place.threadRootId ?? ""}`;
  const latest = Math.max(...messages.map((message) => message.sequence));
  if (baseline?.place !== key) return { agentIds: [], baseline: { place: key, sequence: latest } };
  const agentIds = messages
    .filter(
      (message) =>
        message.senderKind === "agent" &&
        message.senderAgentId !== undefined &&
        (message.threadRootId ?? null) === place.threadRootId &&
        message.sequence > baseline.sequence &&
        nowMs - new Date(message.createdAt).getTime() <= REPLY_INTENT_NEW_POST_MS,
    )
    .map((message) => message.senderAgentId!);
  return { agentIds, baseline: { place: key, sequence: Math.max(baseline.sequence, latest) } };
}

/**
 * An Agent that posts in the open place has made good on what it announced, so one of its entries
 * there ends for each message of its that arrives among the shown ones (`lookForAgentPosts`), the
 * oldest first. History paged in never ends anything.
 */
export function useEndWhenAgentPosts(
  conversationId: string,
  threadRootId: string | null,
  messages: readonly ShownMessage[],
) {
  const intents = useReplyIntentStore();
  const held = useRef<PostBaseline>(undefined);
  useEffect(() => {
    const look = lookForAgentPosts(
      held.current,
      { conversationId, threadRootId },
      messages,
      Date.now(),
    );
    held.current = look.baseline;
    for (const agentId of look.agentIds) intents.clearAgent(agentId, conversationId, threadRootId);
  }, [intents, conversationId, threadRootId, messages]);
}
