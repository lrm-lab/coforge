import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository read position", () => {
  test("markRead clamps the boundary to the conversation end and stays monotone", async () => {
    const updated: { where: object; data: object }[] = [];
    const reads: { data: object }[] = [];
    const db = {
      $transaction: async (callback: (tx: object) => Promise<void>) =>
        callback({
          message: {
            findFirst: async () => ({ sequence: 7 }),
          },
          // A direct conversation: the cursor's move is recorded with its time (`recordReadAdvance`).
          conversation: {
            findUnique: async () => ({ directKey: "direct-key", workspaceId: "workspace-1" }),
          },
          messageRead: {
            findFirst: async () => null,
            create: async (input: { data: object }) => reads.push(input),
          },
          conversationMember: {
            findFirst: async () => ({ id: "member-1" }),
            updateMany: async (input: { where: object; data: object }) => {
              updated.push(input);
              return { count: 1 };
            },
          },
        }),
    } as unknown as PrismaClient;

    // An over-eager client is clamped to the conversation's current end.
    await new PrismaDirectConversationRepository(db).markReadForUser(
      "user-1",
      "conversation-1",
      10_000,
    );
    expect(updated).toEqual([
      {
        where: {
          id: "member-1",
          readThroughSequence: { lt: 7 },
        },
        data: { readThroughSequence: 7 },
      },
      // Reading to the end also consumes a forced `mark as unread` marker at or below it, so the
      // badge cannot come back on the next render (P2b, #125).
      {
        where: {
          id: "member-1",
          unreadFromSequence: { not: null, lte: 7 },
        },
        data: { unreadFromSequence: null },
      },
    ]);
    expect(reads).toMatchObject([
      { data: { conversationId: "conversation-1", memberId: "member-1", sequence: 7 } },
    ]);

    // An empty conversation refuses to move the cursor to a non-positive boundary.
    updated.length = 0;
    const emptyDb = {
      $transaction: async (callback: (tx: object) => Promise<void>) =>
        callback({
          message: {
            findFirst: async () => undefined,
          },
          conversationMember: {
            updateMany: async (input: { where: object; data: object }) => {
              updated.push(input);
              return { count: 1 };
            },
          },
        }),
    } as unknown as PrismaClient;
    await new PrismaDirectConversationRepository(emptyDb).markReadForUser(
      "user-1",
      "conversation-1",
      5,
    );
    expect(updated).toEqual([]);
  });
});
