import { describe, expect, test } from "bun:test";
import {
  encodeAgentReplyIntent,
  REPLY_INTENT_DEADLINE_MS,
  REPLY_INTENT_REFRESH_MS,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";

import { decodeActivityFrame } from "#src/features/agents/agent-activity";
import {
  agentPostsAmong,
  applyUserChannelPublication,
  createReplyIntentStore,
  replyIntentInScope,
  replyingAgentIds,
  REPLY_INTENT_NEW_POST_MS,
  REPLY_INTENT_TOMBSTONE_MS,
} from "#src/features/agents/reply-intents";

/** A store on a clock and a one-shot timer the test advances. */
function subject() {
  let now = 1_000_000;
  let timer: { at: number; callback: () => void } | undefined;
  const intents = createReplyIntentStore({
    now: () => now,
    schedule: (callback, delayMs) => {
      const mine = { at: now + delayMs, callback };
      timer = mine;
      return () => {
        if (timer === mine) timer = undefined;
      };
    },
  });
  let posts = 0;
  return {
    intents,
    /** A message of the Agent's arriving now in a place, `ageMs` after it was written. */
    posted(agentId: string, threadRootId: string | null = null, ageMs = 0, messageId?: string) {
      intents.agentPosted({
        messageId: messageId ?? `message-${(posts += 1)}`,
        agentId,
        conversationId: "conversation-1",
        threadRootId,
        createdAt: new Date(now - ageMs),
      });
    },
    entries: () => intents.store.state,
    hasTimer: () => timer !== undefined,
    advance(ms: number) {
      const target = now + ms;
      while (timer && timer.at <= target) {
        const due = timer;
        timer = undefined;
        now = due.at;
        due.callback();
      }
      now = target;
    },
  };
}

const start = (
  agentId: string,
  callId: string,
  conversationId = "conversation-1",
  threadRootId?: string,
) =>
  ({
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    agentId,
    observedAtMs: 1,
    intent: {
      phase: REPLY_INTENT_PHASE.START,
      callId,
      conversationId,
      ...(threadRootId ? { threadRootId } : {}),
    },
  }) satisfies AgentReplyIntent;

const end = (agentId: string, callId: string) =>
  ({
    ...start(agentId, callId),
    intent: { phase: REPLY_INTENT_PHASE.END, callId },
  }) satisfies AgentReplyIntent;

describe("reply intent store", () => {
  test("a start shows its Agent in its conversation; a thread start shows in that thread only", () => {
    const { intents, entries } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("ben", "c2", "conversation-1", "root-1"));
    expect(replyingAgentIds(entries(), "conversation-1", null)).toEqual(["atlas"]);
    expect(replyingAgentIds(entries(), "conversation-1", "root-1")).toEqual(["ben"]);
    expect(replyingAgentIds(entries(), "conversation-2", null)).toEqual([]);
  });

  test("agents are listed once each, in the order they started", () => {
    const { intents, entries } = subject();
    intents.apply(start("ben", "c1"));
    intents.apply(start("atlas", "c2"));
    intents.apply(start("ben", "c3"));
    expect(replyingAgentIds(entries(), "conversation-1", null)).toEqual(["ben", "atlas"]);
  });

  test("an end removes only its call", () => {
    const { intents, entries } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("atlas", "c2"));
    intents.apply(end("atlas", "c1"));
    expect(entries().map((entry) => entry.callId)).toEqual(["c2"]);
    intents.apply(end("atlas", "c2"));
    expect(entries()).toEqual([]);
  });

  test("an entry not repeated lapses at its deadline, and a repeat extends it", () => {
    const { intents, entries, advance } = subject();
    intents.apply(start("atlas", "c1"));
    advance(REPLY_INTENT_DEADLINE_MS - 1);
    intents.apply(start("atlas", "c1"));
    advance(REPLY_INTENT_DEADLINE_MS - 1);
    expect(entries()).toHaveLength(1);
    advance(1);
    expect(entries()).toEqual([]);
  });

  test("a repeat does not change what a reader sees", () => {
    const { intents, entries } = subject();
    intents.apply(start("atlas", "c1"));
    const before = entries();
    intents.apply(start("atlas", "c1"));
    expect(entries()).toBe(before);
  });

  test("a start arriving after the call's end cannot bring it back", () => {
    const { intents, entries, advance } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(end("atlas", "c1"));
    intents.apply(start("atlas", "c1"));
    expect(entries()).toEqual([]);
    // Another call of the same Agent is a new call.
    intents.apply(start("atlas", "c2"));
    expect(entries()).toHaveLength(1);
    // The memory of an ended call is short.
    intents.apply(end("atlas", "c2"));
    advance(REPLY_INTENT_TOMBSTONE_MS);
    intents.apply(start("atlas", "c2"));
    expect(entries()).toHaveLength(1);
  });

  test("a message from the Agent in the place clears one entry there, the oldest, and the call stays ended", () => {
    const { intents, entries, posted } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("atlas", "c2", "conversation-1", "root-1"));
    intents.apply(start("atlas", "c3", "conversation-2"));
    intents.apply(start("atlas", "c5"));
    intents.apply(start("ben", "c4"));
    posted("atlas");
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c5", "c4"]);
    // The ended call cannot be brought back by a late repeat of its start.
    intents.apply(start("atlas", "c1"));
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c5", "c4"]);
    // The next message from the Agent there ends the next entry, not every one.
    posted("atlas");
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c4"]);
    // A reply in a thread ends the Agent's entry in that thread, wherever its root is shown.
    posted("atlas", "root-1");
    expect(entries().map((entry) => entry.callId)).toEqual(["c3", "c4"]);
  });

  test("the same message arriving twice, or an old one read again, ends nothing more", () => {
    const { intents, entries, posted } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("atlas", "c2"));
    posted("atlas", null, 0, "message-a");
    posted("atlas", null, 0, "message-a");
    expect(entries().map((entry) => entry.callId)).toEqual(["c2"]);
    posted("atlas", null, REPLY_INTENT_NEW_POST_MS + 1);
    expect(entries().map((entry) => entry.callId)).toEqual(["c2"]);
  });

  test("a reply that beats its start ends that start when it comes, and its repeats", () => {
    const { intents, entries, posted, advance } = subject();
    posted("atlas", "root-1");
    // The late start of the call that sent it, in the same place: never shown.
    intents.apply(start("atlas", "c1", "conversation-1", "root-1"));
    expect(entries()).toEqual([]);
    advance(REPLY_INTENT_REFRESH_MS - 1);
    intents.apply(start("atlas", "c1", "conversation-1", "root-1"));
    expect(entries()).toEqual([]);
    // Another place, or another Agent, is not that call.
    intents.apply(start("atlas", "c2"));
    intents.apply(start("ben", "c3", "conversation-1", "root-1"));
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3"]);
  });

  test("a reply's claim on a late start lapses after one refresh period", () => {
    const { intents, entries, posted, advance } = subject();
    posted("atlas", "root-1");
    advance(REPLY_INTENT_REFRESH_MS + 1);
    intents.apply(start("atlas", "c1", "conversation-1", "root-1"));
    expect(entries().map((entry) => entry.callId)).toEqual(["c1"]);
  });

  test("the timer is armed for a new call or a tombstone, not for a repeat", () => {
    const { intents, hasTimer, advance } = subject();
    intents.apply(start("atlas", "c1"));
    expect(hasTimer()).toBe(true);
    advance(5_000);
    // A repeat extends the deadline; the pending timer fires at the old one and re-arms itself.
    intents.apply(start("atlas", "c1"));
    advance(REPLY_INTENT_DEADLINE_MS - 5_000);
    expect(intents.store.state).toHaveLength(1);
    advance(5_000);
    expect(intents.store.state).toEqual([]);
  });

  test("an Agent shows at most four calls at once", () => {
    const { intents, entries } = subject();
    for (let i = 1; i <= 5; i++) intents.apply(start("atlas", `c${i}`));
    expect(entries().map((entry) => entry.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("clear empties it and leaves no timer, forgetting ended calls too", () => {
    const { intents, entries, hasTimer } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("atlas", "c2"));
    intents.apply(end("atlas", "c2"));
    intents.clear();
    expect(entries()).toEqual([]);
    expect(hasTimer()).toBe(false);
    intents.apply(start("atlas", "c2"));
    expect(entries()).toHaveLength(1);
  });

  test("one timer serves every entry and it stops when nothing is left", () => {
    const { intents, hasTimer, advance, entries } = subject();
    expect(hasTimer()).toBe(false);
    intents.apply(start("atlas", "c1"));
    advance(5_000);
    intents.apply(start("ben", "c2"));
    expect(hasTimer()).toBe(true);
    advance(REPLY_INTENT_DEADLINE_MS - 5_000);
    expect(entries().map((entry) => entry.callId)).toEqual(["c2"]);
    advance(5_000);
    expect(entries()).toEqual([]);
    advance(REPLY_INTENT_TOMBSTONE_MS * 2);
    expect(hasTimer()).toBe(false);
  });
});

describe("the Agents' messages among those arriving", () => {
  test("are each Agent message with its place; a person's or a notice is none", () => {
    const createdAt = "2026-10-24T12:00:00.000Z";
    expect(
      agentPostsAmong("conversation-1", [
        { id: "m1", senderKind: "agent", senderAgentId: "atlas", createdAt },
        { id: "m2", senderKind: "agent", senderAgentId: "ben", threadRootId: "root-1", createdAt },
        { id: "m3", senderKind: "user", createdAt },
        { id: "m4", senderKind: "system", createdAt },
      ]),
    ).toEqual([
      {
        messageId: "m1",
        agentId: "atlas",
        conversationId: "conversation-1",
        threadRootId: null,
        createdAt,
      },
      {
        messageId: "m2",
        agentId: "ben",
        conversationId: "conversation-1",
        threadRootId: "root-1",
        createdAt,
      },
    ]);
  });
});

describe("reply intent frames", () => {
  const scope = { workspaceId: "workspace-1" };

  test("a relayed start and end are read as they are", () => {
    expect(replyIntentInScope(start("atlas", "c1"), scope)).toEqual(start("atlas", "c1"));
    expect(replyIntentInScope(end("atlas", "c1"), scope)).toEqual(end("atlas", "c1"));
  });

  test("ignores a start the server did not resolve, another Workspace's frame, and another Agent's on a per-Agent channel", () => {
    const unresolved = {
      ...start("atlas", "c1"),
      intent: { phase: REPLY_INTENT_PHASE.START, callId: "c1", target: "#general" },
    } satisfies AgentReplyIntent;
    expect(replyIntentInScope(unresolved, scope)).toBeUndefined();
    expect(
      replyIntentInScope({ ...start("atlas", "c1"), workspaceId: "workspace-2" }, scope),
    ).toBeUndefined();
    expect(replyIntentInScope(start("atlas", "c1"), { ...scope, agentId: "ben" })).toBeUndefined();
  });

  test("a publication decodes once into a reply intent or an observation, and anything else is nothing", () => {
    const frame = decodeActivityFrame(encodeAgentReplyIntent(start("atlas", "c1")));
    expect(frame && "replyIntent" in frame && frame.replyIntent).toEqual(start("atlas", "c1"));
    expect(decodeActivityFrame(Uint8Array.from([1, 2, 3]))).toBeUndefined();
    expect(decodeActivityFrame("text")).toBeUndefined();
  });
});

describe("a direct message's reply intents on the viewer's own channel", () => {
  const publish = (value: AgentReplyIntent) => encodeAgentReplyIntent(value);

  test("a start and an end published there reach the store", () => {
    const { intents, entries } = subject();
    applyUserChannelPublication(intents, publish(start("atlas", "c1", "dm-1")), "workspace-1");
    expect(entries()).toEqual([
      { agentId: "atlas", callId: "c1", conversationId: "dm-1", threadRootId: null },
    ]);
    expect(replyingAgentIds(entries(), "dm-1", null)).toEqual(["atlas"]);
    applyUserChannelPublication(intents, publish(end("atlas", "c1")), "workspace-1");
    expect(entries()).toEqual([]);
  });

  test("another Workspace's frame, the channel's other events and garbage are nothing", () => {
    const { intents, entries } = subject();
    applyUserChannelPublication(
      intents,
      publish({ ...start("atlas", "c1", "dm-1"), workspaceId: "workspace-2" }),
      "workspace-1",
    );
    applyUserChannelPublication(
      intents,
      new TextEncoder().encode(JSON.stringify({ type: "message.available.v1" })),
      "workspace-1",
    );
    applyUserChannelPublication(intents, Uint8Array.from([1, 2, 3]), "workspace-1");
    applyUserChannelPublication(intents, { type: "message.available.v1" }, "workspace-1");
    expect(entries()).toEqual([]);
  });
});
