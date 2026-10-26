import { createStore } from "@tanstack/react-store";
import {
  REPLY_INTENT_DEADLINE_MS,
  REPLY_INTENT_MAX_LIVE_PER_AGENT,
  REPLY_INTENT_PHASE,
  REPLY_INTENT_REFRESH_MS,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { WORKSPACE_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";

import { decodeActivityFrame } from "./agent-activity";

/** How long the browser remembers an ended call so a late repeat of its start cannot revive it. */
export const REPLY_INTENT_TOMBSTONE_MS = 60_000;

/** How recent an Agent's message must be to count as having just arrived. */
export const REPLY_INTENT_NEW_POST_MS = 60_000;

/** An Agent's message as it arrives in the browser, as far as ending what it announced needs. */
export type AgentPost = {
  messageId: string;
  agentId: string;
  conversationId: string;
  /** Null for a top-level message. */
  threadRootId: string | null;
  createdAt: Date | string;
};

/** A message of a conversation as it arrives, as far as telling an Agent's apart needs. */
export type ArrivedMessage = {
  id: string;
  senderKind: string;
  senderAgentId?: string;
  /** The thread the message replies in; none for a top-level message. */
  threadRootId?: string;
  createdAt: Date | string;
};

/** The Agents' messages among those arriving in a conversation. */
export function agentPostsAmong(
  conversationId: string,
  messages: readonly ArrivedMessage[],
): AgentPost[] {
  return messages.flatMap((message) =>
    message.senderKind === "agent" && message.senderAgentId
      ? [
          {
            messageId: message.id,
            agentId: message.senderAgentId,
            conversationId,
            threadRootId: message.threadRootId ?? null,
            createdAt: message.createdAt,
          },
        ]
      : [],
  );
}

/** One call of one Agent that is about to post, where the server resolved its target. */
export type ReplyIntentEntry = {
  agentId: string;
  callId: string;
  conversationId: string;
  /** Null for a top-level post. */
  threadRootId: string | null;
};

/**
 * The reply intent of a decoded frame, or nothing for another Workspace's, another Agent's (on a
 * per-Agent channel) or a start the server did not resolve. Realtime data is untrusted input.
 */
export function replyIntentInScope(
  frame: AgentReplyIntent,
  scope: { workspaceId: string; agentId?: string },
): AgentReplyIntent | undefined {
  return frame.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR ||
    frame.workspaceId !== scope.workspaceId ||
    (scope.agentId !== undefined && frame.agentId !== scope.agentId) ||
    (frame.intent.phase === REPLY_INTENT_PHASE.START && !frame.intent.conversationId)
    ? undefined
    : frame;
}

/** The Agents replying in one place (a conversation's top level, or one of its threads), once each,
 * in the order they started. */
export function replyingAgentIds(
  entries: readonly ReplyIntentEntry[],
  conversationId: string,
  threadRootId: string | null,
): string[] {
  const ids = new Set<string>();
  for (const entry of entries)
    if (entry.conversationId === conversationId && entry.threadRootId === threadRootId)
      ids.add(entry.agentId);
  return [...ids];
}

type Schedule = (callback: () => void, delayMs: number) => () => void;

const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

const callKey = (agentId: string, callId: string) => `${agentId}\u0000${callId}`;
const placeKey = (agentId: string, conversationId: string, threadRootId: string | null) =>
  `${agentId}\u0000${conversationId}\u0000${threadRootId ?? ""}`;

/**
 * Who is about to post, as the browser holds it. A start adds an entry keyed by Agent and call that
 * lapses `REPLY_INTENT_DEADLINE_MS` later unless the daemon repeats it; an end, or a message from
 * that Agent in that place arriving (`agentPosted`: one entry per message, the oldest first),
 * removes it and remembers the call as ended for a minute so a late repeat cannot bring it back. A
 * message that arrives before any start there claims the next new start of that Agent in that place
 * within one refresh period: that is the late start of the call that sent it. (Raft has no such
 * claim and shows that late start until it lapses; the cost here is that a second message the same
 * Agent starts there within those 8 seconds shows no line.) One timer, set for the next
 * deadline when a call is new or one ends, prunes both. Everything is volatile and best effort: a
 * lost frame only shortens or lengthens the line by its deadline.
 *
 * `store.state` changes only when the set of entries does, so a repeat re-renders nobody.
 */
export function createReplyIntentStore(options: { now?: () => number; schedule?: Schedule } = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleTimeout;
  const store = createStore<readonly ReplyIntentEntry[]>([]);
  const deadlines = new Map<string, number>();
  const ended = new Map<string, number>();
  const readers = new Map<string, number>();
  /** Messages already seen, and the places where a message beat its start, until they expire. */
  const seenPosts = new Map<string, number>();
  const earlyPosts = new Map<string, number>();
  let stopTimer: (() => void) | undefined;
  let timerAt: number | undefined;

  const arm = () => {
    const next = Math.min(
      ...deadlines.values(),
      ...ended.values(),
      ...seenPosts.values(),
      ...earlyPosts.values(),
    );
    if (next === Infinity) {
      stopTimer?.();
      stopTimer = timerAt = undefined;
    } else if (timerAt === undefined || next < timerAt) {
      stopTimer?.();
      timerAt = next;
      stopTimer = schedule(prune, Math.max(0, next - now()));
    }
  };

  /** Removes the entries `matches` picks; with `tombstone`, their calls are remembered as ended. */
  const end = (
    matches: (entry: ReplyIntentEntry) => boolean,
    { tombstone }: { tombstone: boolean },
  ) => {
    const removed = store.state.filter(matches);
    if (removed.length === 0) return;
    for (const entry of removed) {
      const key = callKey(entry.agentId, entry.callId);
      deadlines.delete(key);
      if (tombstone) ended.set(key, now() + REPLY_INTENT_TOMBSTONE_MS);
    }
    store.setState((entries) => entries.filter((entry) => !matches(entry)));
    if (tombstone) arm();
  };

  function prune() {
    stopTimer = timerAt = undefined;
    const at = now();
    for (const remembered of [ended, seenPosts, earlyPosts])
      for (const [key, expiry] of remembered) if (expiry <= at) remembered.delete(key);
    end((entry) => (deadlines.get(callKey(entry.agentId, entry.callId)) ?? 0) <= at, {
      tombstone: false,
    });
    arm();
  }

  const clearConversation = (conversationId: string) => {
    end((entry) => entry.conversationId === conversationId, { tombstone: false });
    arm();
  };

  return {
    store,
    clearConversation,
    /** Views share live state; closing one must not clear another view of the same conversation. */
    retainConversation(conversationId: string) {
      readers.set(conversationId, (readers.get(conversationId) ?? 0) + 1);
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        const remaining = (readers.get(conversationId) ?? 1) - 1;
        if (remaining) readers.set(conversationId, remaining);
        else {
          readers.delete(conversationId);
          clearConversation(conversationId);
        }
      };
    },

    apply({ agentId, intent }: AgentReplyIntent, conversationId?: string) {
      const key = callKey(agentId, intent.callId);
      const endedKey = conversationId ? `${key}\0${conversationId}` : key;
      if (
        conversationId &&
        intent.phase === REPLY_INTENT_PHASE.START &&
        intent.conversationId !== conversationId
      )
        return;
      if (intent.phase === REPLY_INTENT_PHASE.END) {
        // Remembered even when no start was seen: an end can beat its start.
        ended.set(endedKey, now() + REPLY_INTENT_TOMBSTONE_MS);
        end(
          (entry) =>
            entry.agentId === agentId &&
            entry.callId === intent.callId &&
            (conversationId === undefined || entry.conversationId === conversationId),
          {
            tombstone: conversationId === undefined,
          },
        );
        arm();
        return;
      }
      if (ended.has(key) || ended.has(endedKey) || !intent.conversationId) return;
      if (
        conversationId &&
        store.state.some(
          (entry) =>
            entry.agentId === agentId &&
            entry.callId === intent.callId &&
            entry.conversationId !== conversationId,
        )
      )
        return;
      const isNew = !deadlines.has(key);
      const place = placeKey(agentId, intent.conversationId, intent.threadRootId ?? null);
      if (isNew && earlyPosts.has(place)) {
        // The message this call sent is already here: its start is late, and so is any repeat.
        earlyPosts.delete(place);
        ended.set(key, now() + REPLY_INTENT_TOMBSTONE_MS);
        arm();
        return;
      }
      if (isNew) {
        const live = store.state.filter((entry) => entry.agentId === agentId).length;
        if (live >= REPLY_INTENT_MAX_LIVE_PER_AGENT) return;
        const entry: ReplyIntentEntry = {
          agentId,
          callId: intent.callId,
          conversationId: intent.conversationId,
          threadRootId: intent.threadRootId ?? null,
        };
        store.setState((entries) => [...entries, entry]);
      }
      deadlines.set(key, now() + REPLY_INTENT_DEADLINE_MS);
      if (isNew) arm();
    },

    /**
     * An Agent's message arrived, so the oldest thing it announced in that place has come true.
     * The same message seen again, or an old one read in again, ends nothing.
     */
    agentPosted({ messageId, agentId, conversationId, threadRootId, createdAt }: AgentPost) {
      const at = now();
      if (seenPosts.has(messageId) || at - new Date(createdAt).getTime() > REPLY_INTENT_NEW_POST_MS)
        return;
      seenPosts.set(messageId, at + REPLY_INTENT_NEW_POST_MS);
      const oldest = store.state.find(
        (entry) =>
          entry.agentId === agentId &&
          entry.conversationId === conversationId &&
          entry.threadRootId === threadRootId,
      );
      if (oldest) end((entry) => entry === oldest, { tombstone: true });
      else {
        earlyPosts.set(
          placeKey(agentId, conversationId, threadRootId),
          at + REPLY_INTENT_REFRESH_MS,
        );
        arm();
      }
    },

    /** Forgets everything: the realtime connection may have missed any of it, or the Workspace
     * changed. */
    clear() {
      stopTimer?.();
      stopTimer = timerAt = undefined;
      deadlines.clear();
      ended.clear();
      seenPosts.clear();
      earlyPosts.clear();
      if (store.state.length > 0) store.setState(() => []);
    },
  };
}

export type ReplyIntentStore = ReturnType<typeof createReplyIntentStore>;

/**
 * Feeds the store what a publication on the viewer's own channel (`chat:user:<id>`) carries, if it
 * is a reply intent of this Workspace: the server publishes the reply intents of a direct message
 * there. The channel carries other events too, which are nothing here.
 */
export function applyUserChannelPublication(
  replyIntents: ReplyIntentStore,
  data: unknown,
  workspaceId: string,
) {
  const frame = decodeActivityFrame(data);
  const replyIntent =
    frame && "replyIntent" in frame
      ? replyIntentInScope(frame.replyIntent, { workspaceId })
      : undefined;
  if (replyIntent) replyIntents.apply(replyIntent);
}

/** A chat channel supplies the scope missing from a stripped end; other publications are inert. */
export function applyConversationChannelPublication(
  replyIntents: ReplyIntentStore,
  data: unknown,
  workspaceId: string,
  conversationId: string,
) {
  const frame = decodeActivityFrame(data);
  const intent =
    frame && "replyIntent" in frame
      ? replyIntentInScope(frame.replyIntent, { workspaceId })
      : undefined;
  if (intent) replyIntents.apply(intent, conversationId);
}
