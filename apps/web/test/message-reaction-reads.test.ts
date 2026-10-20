import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { readMessageReactions } from "#src/server/conversations/message-reaction-reads.server";

const input = {
  workspaceId: "workspace-1",
  userId: "user-1",
  conversationId: "conversation-1",
  messageIds: ["message-1", "message-2"],
};

/** A channel the viewer may read (or a Workspace they are not in), and two of its messages. */
function fakeDb({ member = true } = {}) {
  const reads: { where: unknown; isolationLevel?: string }[] = [];
  const db = {
    workspaceMembership: { findUnique: async () => (member ? { userId: "user-1" } : null) },
    conversation: {
      findFirst: async () => ({ directKey: null, channelName: "general", members: [] }),
    },
    message: {
      findMany: (query: { where: unknown }) => {
        reads.push({ where: query.where });
        return [
          {
            id: "message-1",
            reactionVersion: 4,
            reactions: [
              {
                emoji: "👍",
                member: {
                  userId: "user-2",
                  agentId: null,
                  agent: null,
                  user: { username: "ada-1", displayName: "Ada" },
                },
              },
            ],
          },
          { id: "message-2", reactionVersion: 2, reactions: [] },
        ];
      },
    },
    $transaction: async (queries: unknown[], options: { isolationLevel: string }) => {
      reads[reads.length - 1]!.isolationLevel = options.isolationLevel;
      return Promise.all(queries);
    },
  } as unknown as PrismaClient;
  return { db, reads };
}

describe("readMessageReactions", () => {
  test("returns each message's summary with its version, read in one snapshot", async () => {
    const { db, reads } = fakeDb();
    expect(await readMessageReactions(db, input)).toEqual({
      "message-1": {
        reactions: [{ emoji: "👍", count: 1, reactors: [{ id: "user-2", label: "Ada" }] }],
        version: 4,
      },
      "message-2": { reactions: null, version: 2 },
    });
    expect(reads).toEqual([
      {
        where: {
          id: { in: ["message-1", "message-2"] },
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
        },
        isolationLevel: "RepeatableRead",
      },
    ]);
  });

  test("someone who may not read the conversation reads nothing", async () => {
    const { db, reads } = fakeDb({ member: false });
    const error = await readMessageReactions(db, input).catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
    expect(reads).toEqual([]);
  });
});
