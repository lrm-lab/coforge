import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { MessageReactionEvent } from "#src/features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { writeReaction } from "#src/server/conversations/reaction-write.server";

type Row = { emoji: string; memberId: string };

/**
 * One message's reactions and `reactionVersion` as PostgreSQL holds them, behind a transaction
 * that applies its writes only once its callback returns (the commit). `log` records the order of
 * the version bump, the reaction write, the summary read, the commit and each publication.
 */
function fakeDb({ gone = false } = {}) {
  const log: string[] = [];
  const stored = { version: 0, rows: [] as Row[] };
  const db = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => {
      const draft = { version: stored.version, rows: [...stored.rows] };
      const tx = {
        message: {
          updateManyAndReturn: async (query: { where: unknown }) => {
            log.push(`bump ${JSON.stringify(query.where)}`);
            if (gone) return [];
            draft.version += 1;
            return [{ reactionVersion: draft.version }];
          },
        },
        messageReaction: {
          upsert: async (query: { create: Row }) => {
            log.push("upsert");
            if (!draft.rows.some((row) => row.emoji === query.create.emoji))
              draft.rows.push({ emoji: query.create.emoji, memberId: query.create.memberId });
          },
          deleteMany: async (query: { where: Row }) => {
            log.push("delete");
            draft.rows = draft.rows.filter(
              (row) => row.emoji !== query.where.emoji || row.memberId !== query.where.memberId,
            );
          },
          findMany: async () => {
            log.push("read");
            return draft.rows.map((row) => ({
              emoji: row.emoji,
              member: {
                userId: row.memberId,
                agentId: null,
                agent: null,
                user: { username: "ada-1", displayName: "Ada" },
              },
            }));
          },
        },
      };
      const result = await work(tx);
      Object.assign(stored, draft);
      log.push("commit");
      return result;
    },
  } as unknown as PrismaClient;
  return { db, log };
}

function recordingRealtime(log: string[]) {
  const published: Omit<MessageReactionEvent, "type">[] = [];
  return {
    published,
    realtime: {
      reactionChanged: async (input: Omit<MessageReactionEvent, "type">) => {
        log.push(`publish v${input.version}`);
        published.push(input);
      },
    },
  };
}

const input = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  threadRootId: null,
  memberId: "user-ada",
  emoji: "👍",
  active: true,
};

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("writeReaction", () => {
  test("raises the message's version in the write's transaction and returns it with the summary", async () => {
    const { db, log } = fakeDb();
    const { realtime } = recordingRealtime(log);
    const first = await writeReaction(db, realtime, input);
    const second = await writeReaction(db, realtime, { ...input, active: false });
    expect(first).toEqual({
      reactions: [{ emoji: "👍", count: 1, reactors: [{ id: "user-ada", label: "Ada" }] }],
      version: 1,
    });
    expect(second).toEqual({ reactions: null, version: 2 });
    expect(log.slice(0, 4)).toEqual([
      `bump ${JSON.stringify({ id: "message-1", conversationId: "conversation-1", workspaceId: "workspace-1" })}`,
      "upsert",
      "read",
      "commit",
    ]);
  });

  test("publishes the whole summary and its version only after the commit", async () => {
    const { db, log } = fakeDb();
    const { realtime, published } = recordingRealtime(log);
    await writeReaction(db, realtime, input);
    expect(log.slice(-2)).toEqual(["commit", "publish v1"]);
    expect(published).toEqual([
      {
        conversationId: "conversation-1",
        messageId: "message-1",
        version: 1,
        reactions: [{ emoji: "👍", count: 1, reactors: [{ id: "user-ada", label: "Ada" }] }],
      },
    ]);
  });

  test("a reply's event names its thread root", async () => {
    const { db, log } = fakeDb();
    const { realtime, published } = recordingRealtime(log);
    await writeReaction(db, realtime, { ...input, threadRootId: "root-1" });
    expect(published[0]).toMatchObject({ messageId: "message-1", threadRootId: "root-1" });
  });

  test("a message gone before the write writes and announces nothing", async () => {
    const { db, log } = fakeDb({ gone: true });
    const { realtime, published } = recordingRealtime(log);
    expect(await writeReaction(db, realtime, input)).toBeUndefined();
    expect(log.filter((step) => !step.startsWith("bump"))).toEqual(["commit"]);
    expect(published).toEqual([]);
  });

  test("a failed publish is logged, never thrown: the reaction is already committed", async () => {
    const { db, log } = fakeDb();
    const realtime = {
      reactionChanged: async () => {
        throw new TypeError("centrifugo down");
      },
    };
    expect(await writeReaction(db, realtime, input)).toMatchObject({ version: 1 });
    expect(log.at(-1)).toBe("commit");
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "conversation_realtime:reaction_changed_failed",
        workspace_id: "workspace-1",
        error_type: "TypeError",
      }),
    );
  });
});

describe("CentrifugoConversationRealtime.reactionChanged", () => {
  test("goes only to the conversation's own channel, each time under a key of its own", async () => {
    const published: { channel: string; data: unknown; key?: string }[] = [];
    const centrifugo = {
      publishJson: async (channel: string, data: unknown, key?: string) => {
        published.push({ channel, data, key });
      },
    } as unknown as CentrifugoServerApi;
    const realtime = new CentrifugoConversationRealtime(centrifugo);
    const change = {
      conversationId: "conversation-1",
      messageId: "message-1",
      threadRootId: "root-1",
      version: 3,
      reactions: null,
    };
    await realtime.reactionChanged(change);
    await realtime.reactionChanged(change);
    expect(published.map(({ channel, data }) => ({ channel, data }))).toEqual([
      { channel: "chat:conversation-1", data: { type: "message.reaction.v1", ...change } },
      { channel: "chat:conversation-1", data: { type: "message.reaction.v1", ...change } },
    ]);
    // Centrifugo drops a publication whose key it saw in the last few minutes.
    const [first, second] = published.map((publication) => publication.key);
    expect(first).toStartWith("message-1:reaction:");
    expect(first).not.toBe(second);
  });
});
