import { describe, expect, test } from "bun:test";
import {
  encodeAgentReplyIntent,
  REPLY_INTENT_DEADLINE_MS,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";

import { decodeActivityFrame } from "#src/features/agents/agent-activity";
import {
  applyUserChannelPublication,
  createReplyIntentStore,
  replyIntentInScope,
  replyingAgentIds,
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
  return {
    intents,
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
    const { intents, entries } = subject();
    intents.apply(start("atlas", "c1"));
    intents.apply(start("atlas", "c2", "conversation-1", "root-1"));
    intents.apply(start("atlas", "c3", "conversation-2"));
    intents.apply(start("atlas", "c5"));
    intents.apply(start("ben", "c4"));
    intents.clearAgent("atlas", "conversation-1", null);
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c5", "c4"]);
    // The ended call cannot be brought back by a late repeat of its start.
    intents.apply(start("atlas", "c1"));
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c5", "c4"]);
    // The next message from the Agent there ends the next entry, not every one.
    intents.clearAgent("atlas", "conversation-1", null);
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c4"]);
    intents.clearAgent("atlas", "conversation-1", null);
    expect(entries().map((entry) => entry.callId)).toEqual(["c2", "c3", "c4"]);
    intents.clearAgent("atlas", "conversation-1", "root-1");
    expect(entries().map((entry) => entry.callId)).toEqual(["c3", "c4"]);
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
