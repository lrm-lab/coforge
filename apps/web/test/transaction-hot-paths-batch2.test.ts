import { expect, test } from "bun:test";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppBotInbox } from "#src/server/app-bots/app-bot-inbox.server";
import { dismissAgentInbox } from "#src/server/agents/agent-inbox-actions.server";
import { drainAgentEvents } from "#src/server/db/repositories/agent-event-drain.repositories.server";
import { dismissDueAgentReminders } from "#src/server/reminders/agent-inbox-reminders.server";

const WORKSPACE_ID = "0196ed00-0000-7000-8000-000000000001";
const AGENT_ID = "0196ed00-0000-7000-8000-000000000002";
const USER_ID = "0196ed00-0000-7000-8000-000000000003";

function sqlText(arg: unknown): string {
  if (Array.isArray(arg)) return arg.join(" ");
  if (arg && typeof arg === "object" && "strings" in arg && Array.isArray(arg.strings))
    return (arg.strings as string[]).join(" ");
  return String(arg ?? "");
}

test("drainAgentEvents hydrates messages after commit and batches read-group advances inside tx", async () => {
  const convIds = [
    "0196ed00-0000-7000-8000-000000000101",
    "0196ed00-0000-7000-8000-000000000102",
    "0196ed00-0000-7000-8000-000000000103",
    "0196ed00-0000-7000-8000-000000000104",
  ];
  const msgIds = [
    "0196ed00-0000-7000-8000-000000000201",
    "0196ed00-0000-7000-8000-000000000202",
    "0196ed00-0000-7000-8000-000000000203",
    "0196ed00-0000-7000-8000-000000000204",
  ];
  const memberIds = [
    "0196ed00-0000-7000-8000-000000000301",
    "0196ed00-0000-7000-8000-000000000302",
    "0196ed00-0000-7000-8000-000000000303",
    "0196ed00-0000-7000-8000-000000000304",
  ];

  let inTx = false;
  let messageFindManyInTx = 0;
  let messageFindManyAfterTx = 0;
  let memberUpdateManyInTx = 0;
  let txBatchQueries = 0;

  const messageRows = msgIds.map((id, index) => ({
    id,
    conversationId: convIds[index]!,
    sequence: 10 + index,
    body: `msg-${index}`,
    createdAt: new Date("2026-11-20T00:00:00.000Z"),
    threadRootId: null,
    senderMember: {
      agentId: null,
      user: { username: "alice", displayName: "Alice", description: null },
      agent: null,
    },
    attachments: [],
    sourceOfTasks: [],
    actionCard: null,
    mentions: [],
    forwards: [],
    attachmentComment: null,
    _count: { replies: 0 },
    conversation: {
      id: convIds[index]!,
      channelName: `chan-${index}`,
      directKey: null,
      kind: null,
      attachmentCommentThread: null,
      members: [],
      taskDiscussionOf: null,
    },
  }));

  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      inTx = true;
      try {
        return await fn(tx);
      } finally {
        inTx = false;
      }
    },
    message: {
      findMany: async () => {
        if (inTx) messageFindManyInTx += 1;
        else messageFindManyAfterTx += 1;
        return messageRows;
      },
    },
    conversation: {
      findMany: async () =>
        convIds.map((id, index) => ({
          id,
          channelName: `chan-${index}`,
          directKey: null,
          attachmentCommentThread: null,
          coordinatorAgentId: null,
          coordinatorAgent: null,
        })),
    },
    conversationMember: {
      findMany: async () =>
        convIds.map((conversationId, index) => ({
          id: memberIds[index]!,
          conversationId,
        })),
      updateMany: async () => {
        if (inTx) memberUpdateManyInTx += 1;
        return { count: 1 };
      },
    },
    pendingMentionAction: {
      updateMany: async () => ({ count: 0 }),
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("FROM unread")) {
        return msgIds.map((id, index) => ({
          id,
          conversationId: convIds[index]!,
          threadRootId: null,
          sequence: 10 + index,
          nonMemberMention: false,
        }));
      }
      if (sql.includes("UPDATE") && sql.includes("conversation_members")) {
        txBatchQueries += 1;
        return convIds.map((conversationId) => ({ conversationId }));
      }
      return [];
    },
    $executeRaw: async () => 1,
  };
  const tx = db;

  const result = await drainAgentEvents(
    { db: db as unknown as PrismaClient } as Parameters<typeof drainAgentEvents>[0],
    WORKSPACE_ID,
    AGENT_ID,
    20,
  );
  expect(result.messages).toHaveLength(4);
  expect(messageFindManyInTx).toBe(0);
  expect(messageFindManyAfterTx).toBe(1);
  expect(memberUpdateManyInTx).toBe(0);
  expect(txBatchQueries).toBe(1);
});

test("AppBotInbox.acknowledge batches channel cursor updates via unnest instead of N sequential updateMany calls", async () => {
  let updateManyCalls = 0;
  let batchedChannelUpdates = 0;
  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    conversationMember: {
      updateMany: async () => {
        updateManyCalls += 1;
        return { count: 1 };
      },
      findMany: async () => [],
    },
    pendingMentionAction: {
      updateMany: async () => ({ count: 0 }),
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("conversation_members") && sql.includes("unnest")) {
        batchedChannelUpdates += 1;
      }
      return 5;
    },
    $queryRaw: async () => [],
    message: { findMany: async () => [] },
    conversation: { findMany: async () => [] },
  };
  const inbox = new AppBotInbox(db as unknown as PrismaClient);
  const cursorPayload = Buffer.from(
    JSON.stringify({
      v: 1,
      groups: [
        ["0196ed00-0000-7000-8000-000000000401", null, 5],
        ["0196ed00-0000-7000-8000-000000000402", null, 8],
        ["0196ed00-0000-7000-8000-000000000403", null, 12],
        ["0196ed00-0000-7000-8000-000000000404", null, 15],
        ["0196ed00-0000-7000-8000-000000000405", null, 20],
      ],
      outside: [],
    }),
  ).toString("base64url");

  await inbox.check({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID }, { since: cursorPayload });
  expect(updateManyCalls).toBe(0);
  expect(batchedChannelUpdates).toBe(1);
});

test("dismissAgentInbox batches conversation member cursor updates inside its transaction", async () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    memberId: `0196ed00-0000-7000-8000-00000000050${index + 1}`,
    conversationId: `0196ed00-0000-7000-8000-00000000060${index + 1}`,
    channelName: `chan-${index}`,
    directKey: null,
    kind: null,
    peer: null,
    peerKind: null,
    appKey: null,
    maxSeq: 10 + index,
  }));
  let updateManyCalls = 0;
  let batchMemberUpdates = 0;
  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    conversationMember: {
      updateMany: async () => {
        updateManyCalls += 1;
        return { count: 1 };
      },
    },
    reminder: { findMany: async () => [] },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("thread_follows")) return [];
      if (sql.includes("UPDATE") && sql.includes("conversation_members")) {
        batchMemberUpdates += 1;
        return candidates.map(({ conversationId }) => ({ conversationId }));
      }
      return candidates;
    },
  };

  const res = await dismissAgentInbox(
    db as unknown as PrismaClient,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, userId: USER_ID },
    { before: "2026-11-20T00:00:00.000Z" },
  );
  expect(res.dismissedConversations).toBe(6);
  expect(updateManyCalls).toBe(0);
  expect(batchMemberUpdates).toBe(1);
});

test("dismissDueAgentReminders batches one-shot and repeating reminder updates inside tx", async () => {
  const dueBefore = new Date("2026-11-20T12:00:00.000Z");
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `0196ed00-0000-7000-8000-00000000070${index + 1}`,
      title: `one-shot-${index}`,
      target: "#ops",
      fireAt: new Date("2026-11-20T10:00:00.000Z"),
      status: "scheduled",
      version: 1,
      repeat: null,
      timezone: "UTC",
      computerId: "0196ed00-0000-7000-8000-000000000999",
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `0196ed00-0000-7000-8000-00000000080${index + 1}`,
      title: `repeat-${index}`,
      target: "#ops",
      fireAt: new Date("2026-11-20T10:00:00.000Z"),
      status: "scheduled",
      version: 2,
      repeat: "every:1h",
      timezone: "UTC",
      computerId: "0196ed00-0000-7000-8000-000000000999",
    })),
  ];

  let singleUpdateCalls = 0;
  let updateManyCalls = 0;
  let batchRepeatingExecutes = 0;
  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    reminder: {
      findMany: async () => candidates,
      update: async () => {
        singleUpdateCalls += 1;
        return {};
      },
      updateMany: async () => {
        updateManyCalls += 1;
        return { count: 4 };
      },
    },
    reminderOccurrence: {
      updateMany: async () => ({ count: 7 }),
    },
    reminderEvent: {
      createMany: async () => ({ count: 7 }),
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("reminders") && sql.includes("unnest")) batchRepeatingExecutes += 1;
      return 3;
    },
  };

  const dismissed = await dismissDueAgentReminders(
    db as unknown as PrismaClient,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    { dueBefore },
  );
  expect(dismissed).toHaveLength(7);
  expect(singleUpdateCalls).toBe(0);
  expect(updateManyCalls).toBe(1);
  expect(batchRepeatingExecutes).toBe(1);
});

test("linkMessageAttachments batches multi-attachment linking into one unnest SQL statement and deduplicates IDs", async () => {
  const { linkMessageAttachments } =
    await import("#src/server/db/repositories/attachment-link.repositories.server");
  const singleUpdates: Prisma.AttachmentUpdateArgs[] = [];
  let batchUpdates = 0;
  let lastBatchIds: string[] = [];
  let lastBatchPositions: number[] = [];
  const tx = {
    attachment: {
      update: async (args: Prisma.AttachmentUpdateArgs) => {
        singleUpdates.push(args);
      },
    },
    $executeRaw: async (arg: unknown, _messageId: string, ids: string[], positions: number[]) => {
      const sql = sqlText(arg);
      if (sql.includes("attachments") && sql.includes("unnest")) {
        batchUpdates += 1;
        lastBatchIds = ids;
        lastBatchPositions = positions;
      }
      return ids.length;
    },
  };

  await linkMessageAttachments(tx as never, "0196ed00-0000-7000-8000-000000000900", []);
  expect([singleUpdates.length, batchUpdates]).toEqual([0, 0]);

  await linkMessageAttachments(tx as never, "0196ed00-0000-7000-8000-000000000900", [
    "0196ed00-0000-7000-8000-000000000901",
    "0196ed00-0000-7000-8000-000000000901",
  ]);
  expect(batchUpdates).toBe(0);
  expect(singleUpdates).toEqual([
    {
      where: { id: "0196ed00-0000-7000-8000-000000000901" },
      data: { messageId: "0196ed00-0000-7000-8000-000000000900", position: 1 },
    },
  ]);

  await linkMessageAttachments(tx as never, "0196ed00-0000-7000-8000-000000000900", [
    "0196ed00-0000-7000-8000-000000000903",
    "0196ed00-0000-7000-8000-000000000901",
    "0196ed00-0000-7000-8000-000000000903",
  ]);
  expect([singleUpdates.length, batchUpdates]).toEqual([1, 1]);
  expect(lastBatchIds).toEqual([
    "0196ed00-0000-7000-8000-000000000901",
    "0196ed00-0000-7000-8000-000000000903",
  ]);
  expect(lastBatchPositions).toEqual([1, 2]);
});

test("drainAgentEvents skips messages deleted between commit and post-commit hydration", async () => {
  const convId = "0196ed00-0000-7000-8000-000000000911";
  const deletedMsgId = "0196ed00-0000-7000-8000-000000000921";
  const survivingMsgId = "0196ed00-0000-7000-8000-000000000922";
  const memberId = "0196ed00-0000-7000-8000-000000000931";
  const now = new Date("2026-04-20T00:00:00Z");

  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(db),
    conversation: {
      findMany: async () => [
        { id: convId, channelName: "general", directKey: null, attachmentCommentThread: null },
      ],
    },
    conversationMember: {
      findMany: async () => [{ id: memberId, conversationId: convId, leftAt: null }],
    },
    channelPolicy: { findMany: async () => [] },
    conversationPin: { findMany: async () => [] },
    pendingMentionAction: { updateMany: async () => ({ count: 0 }) },
    message: {
      findMany: async () => [
        {
          id: survivingMsgId,
          conversationId: convId,
          sequence: 11,
          threadRootId: null,
          senderKind: "user",
          senderUserId: USER_ID,
          senderAgentId: null,
          senderUser: { id: USER_ID, name: "Alice", handle: "alice" },
          senderAgent: null,
          body: "still here",
          createdAt: now,
          attachments: [],
          mentions: [],
          conversation: {
            id: convId,
            channelName: "general",
            directKey: null,
            kind: null,
            appId: null,
            app: null,
            attachmentCommentThread: null,
          },
        },
      ],
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("WITH unread AS")) {
        return [
          {
            id: deletedMsgId,
            conversationId: convId,
            threadRootId: null,
            sequence: 10,
            nonMemberMention: false,
          },
          {
            id: survivingMsgId,
            conversationId: convId,
            threadRootId: null,
            sequence: 11,
            nonMemberMention: false,
          },
        ];
      }
      if (sql.includes("UPDATE") && sql.includes("conversation_members")) {
        return [{ conversationId: convId }];
      }
      return [];
    },
    $executeRaw: async () => 1,
  };

  const result = await drainAgentEvents(
    { db: db as unknown as PrismaClient } as Parameters<typeof drainAgentEvents>[0],
    WORKSPACE_ID,
    AGENT_ID,
    20,
  );
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.id).toBe(survivingMsgId);
  expect(result.hasMore).toBe(false);
});
