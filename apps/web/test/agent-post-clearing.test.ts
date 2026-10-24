import { describe, expect, test } from "bun:test";

import {
  lookForAgentPosts,
  REPLY_INTENT_NEW_POST_MS,
  type PostBaseline,
} from "#src/features/agents/agent-post-clearing";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const place = { conversationId: "conversation-1", threadRootId: null };
const post = (
  sequence: number,
  senderKind: "user" | "agent" | "system",
  senderAgentId: string | undefined,
  options: { ageMs?: number; threadRootId?: string } = {},
) => ({
  sequence,
  senderKind,
  senderAgentId,
  threadRootId: options.threadRootId,
  createdAt: new Date(now - (options.ageMs ?? 1_000)),
});
const baseline = (sequence: number, root: string | null = null): PostBaseline => ({
  place: `conversation-1:${root ?? ""}`,
  sequence,
});

describe("looking for an Agent's message in the open place", () => {
  test("names the Agents with a new, recent message once per message, and moves the baseline", () => {
    const messages = [
      post(1, "agent", "atlas", { ageMs: REPLY_INTENT_NEW_POST_MS + 1 }),
      post(5, "agent", "ben"),
      post(6, "user", undefined),
      post(7, "agent", "ben"),
      post(8, "agent", "cam"),
    ];
    expect(lookForAgentPosts(baseline(4), place, messages, now)).toEqual({
      agentIds: ["ben", "ben", "cam"],
      baseline: baseline(8),
    });
  });

  test("a page of older history is not news, however it arrives", () => {
    const history = [post(2, "agent", "atlas"), post(3, "agent", "ben")];
    expect(lookForAgentPosts(baseline(10), place, history, now).agentIds).toEqual([]);
    // History loaded after an empty look is older than the news window.
    expect(
      lookForAgentPosts(baseline(0), place, [post(2, "agent", "atlas", { ageMs: 3_600_000 })], now)
        .agentIds,
    ).toEqual([]);
  });

  test("the first look at a place is a baseline, not news", () => {
    expect(lookForAgentPosts(undefined, place, [post(5, "agent", "ben")], now)).toEqual({
      agentIds: [],
      baseline: baseline(5),
    });
    // Another place starts over, too.
    expect(lookForAgentPosts(baseline(1, "root-1"), place, [post(5, "agent", "ben")], now)).toEqual(
      {
        agentIds: [],
        baseline: baseline(5),
      },
    );
  });

  test("an empty list is not a look: it sets no baseline, so the messages that load next are not all news", () => {
    const first = lookForAgentPosts(undefined, place, [], now);
    expect(first).toEqual({ agentIds: [], baseline: undefined });
    // The messages arrive: they are the first look, a baseline, and clear nothing.
    expect(
      lookForAgentPosts(first.baseline, place, [post(5, "agent", "ben")], now).agentIds,
    ).toEqual([]);
    // An empty list after a look keeps that baseline too.
    expect(lookForAgentPosts(baseline(5), place, [], now)).toEqual({
      agentIds: [],
      baseline: baseline(5),
    });
  });

  test("only a message in the place's own thread counts: the top level, or the open thread's root", () => {
    const messages = [post(5, "agent", "ben", { threadRootId: "root-1" }), post(6, "agent", "cam")];
    expect(lookForAgentPosts(baseline(4), place, messages, now).agentIds).toEqual(["cam"]);
    expect(
      lookForAgentPosts(baseline(4, "root-1"), { ...place, threadRootId: "root-1" }, messages, now)
        .agentIds,
    ).toEqual(["ben"]);
    expect(
      lookForAgentPosts(baseline(4, "root-2"), { ...place, threadRootId: "root-2" }, messages, now)
        .agentIds,
    ).toEqual([]);
  });
});
