import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";

const input = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  userId: "user-1",
  messageId: "message-1",
  emoji: "👍",
  active: true,
};

/** A reaction by a person: `userId` is who they are, `names` their profile. */
function reactionRow(
  emoji: string,
  userId: string,
  names: { username: string; displayName: string },
) {
  return {
    emoji,
    member: {
      userId,
      agentId: null,
      agent: null,
      user: names,
    },
  };
}

function agentReactionRow(emoji: string, name: string) {
  return { emoji, member: { userId: null, agentId: `agent-${name}`, agent: { name }, user: null } };
}

function fakeDb(
  overrides: {
    message?: unknown;
    member?: unknown;
    /** The message is deleted between its lookup and the write. */
    gone?: true;
    remaining?: unknown[];
  } = {},
) {
  const calls: string[] = [];
  const db = {
    message: {
      findFirst: async (_query: object) => {
        calls.push("message");
        return "message" in overrides ? overrides.message : { id: "message-1", threadRootId: null };
      },
      updateManyAndReturn: async () => {
        calls.push("version");
        return "gone" in overrides ? [] : [{ reactionVersion: 5 }];
      },
    },
    conversationMember: {
      findFirst: async (_query: object) => {
        calls.push("member");
        return "member" in overrides ? overrides.member : { id: "member-1" };
      },
    },
    messageReaction: {
      upsert: async () => {
        calls.push("upsert");
      },
      deleteMany: async () => {
        calls.push("delete");
      },
      findMany: async () => {
        calls.push("summaries");
        return overrides.remaining ?? [];
      },
    },
  } as unknown as PrismaClient;
  Object.assign(db, {
    $transaction: async (work: (tx: PrismaClient) => Promise<unknown>) => {
      const result = await work(db);
      calls.push("commit");
      return result;
    },
  });
  // The conversation's open pages hear the summary once the write commits (`writeReaction`).
  const realtime = {
    reactionChanged: async ({ version }: { version: number }) => {
      calls.push(`publish v${version}`);
    },
  };
  return { db, calls, realtime };
}

async function appErrorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

describe("toggleUserMessageReaction", () => {
  test("rejects an invalid emoji before touching the database", async () => {
    const { db, calls, realtime } = fakeDb();
    const code = await appErrorCode(() =>
      toggleUserMessageReaction(db, realtime, { ...input, emoji: "not an emoji" }),
    );
    expect(code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  test("reports a message outside the conversation as not found", async () => {
    const { db, calls, realtime } = fakeDb({ message: null });
    const code = await appErrorCode(() => toggleUserMessageReaction(db, realtime, input));
    expect(code).toBe("NOT_FOUND");
    expect(calls).toEqual(["message"]);
  });

  test("denies a reader without an active membership", async () => {
    const { db, calls, realtime } = fakeDb({ member: null });
    const code = await appErrorCode(() => toggleUserMessageReaction(db, realtime, input));
    expect(code).toBe("ACCESS_DENIED");
    expect(calls).toEqual(["message", "member"]);
  });

  test("reports a message deleted before the write as not found", async () => {
    const { db, calls, realtime } = fakeDb({ gone: true });
    const code = await appErrorCode(() => toggleUserMessageReaction(db, realtime, input));
    expect(code).toBe("NOT_FOUND");
    expect(calls).toEqual(["message", "member", "version", "commit"]);
  });

  test("upserts on active and returns the fresh summaries in first-reaction order, with their version", async () => {
    const { db, calls, realtime } = fakeDb({
      remaining: [
        reactionRow("🎉", "user-alice", { username: "alice-3f9", displayName: "Alice" }),
        reactionRow("👍", "user-bob", { username: "bob-7q1", displayName: "Bob" }),
        reactionRow("👍", "user-carol", { username: "carol-2xa", displayName: "Carol" }),
      ],
    });
    const { reactions: summaries, version } = await toggleUserMessageReaction(db, realtime, input);
    expect(calls).toEqual([
      "message",
      "member",
      "version",
      "upsert",
      "summaries",
      "commit",
      "publish v5",
    ]);
    expect(version).toBe(5);
    expect(summaries).toEqual([
      { emoji: "🎉", count: 1, reactors: [{ id: "user-alice", label: "Alice" }] },
      {
        emoji: "👍",
        count: 2,
        reactors: [
          { id: "user-bob", label: "Bob" },
          { id: "user-carol", label: "Carol" },
        ],
      },
    ]);
  });

  test("names a person by their display name, never their username, and an Agent by its @handle", async () => {
    const { db, realtime } = fakeDb({
      remaining: [
        reactionRow("👍", "user-1", {
          username: "frank-an-4k2",
          displayName: "Frankie",
        }),
        reactionRow("👍", "user-2", { username: "ada-9d3", displayName: "  " }),
        agentReactionRow("👍", "atlas"),
      ],
    });
    const { reactions: summaries } = await toggleUserMessageReaction(db, realtime, input);
    expect(summaries?.[0]?.reactors).toEqual([
      { id: "user-1", label: "Frankie" },
      { id: "user-2", label: UNNAMED_PERSON_NAME },
      { id: "agent-atlas", label: "@atlas" },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("frank-an-4k2");
    expect(JSON.stringify(summaries)).not.toContain("ada-9d3");
  });

  test("deletes on inactive and reports no summaries once the last one is gone", async () => {
    const { db, calls, realtime } = fakeDb({ remaining: [] });
    const answer = await toggleUserMessageReaction(db, realtime, { ...input, active: false });
    expect(calls).toEqual([
      "message",
      "member",
      "version",
      "delete",
      "summaries",
      "commit",
      "publish v5",
    ]);
    expect(answer).toEqual({ reactions: null, version: 5 });
  });
});
