import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { recordMembershipNotices } from "#src/server/conversations/channel-membership-notice.server";
import { ChatSections } from "#src/server/conversations/chat-sections.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { GitHubInstallationCache } from "#src/server/integrations/github-installation-cache.server";
import { mergeLabels } from "#src/server/tasks/label-merge.server";

const WORKSPACE_ID = "0196ed00-0000-7000-8000-000000000001";
const USER_ID = "0196ed00-0000-7000-8000-000000000002";
const AGENT_ID = "0196ed00-0000-7000-8000-000000000003";
const COMPUTER_ID = "0196ed00-0000-7000-8000-000000000004";

function sqlText(arg: unknown): string {
  if (Array.isArray(arg)) return arg.join(" ");
  if (arg && typeof arg === "object" && "strings" in arg && Array.isArray(arg.strings))
    return (arg.strings as string[]).join(" ");
  return String(arg ?? "");
}

test("recordMembershipNotices batches conversation filtering, identity lookup, sorted locking, sequence allocation, and message inserts", async () => {
  const c1 = "0196ed00-0000-7000-8000-000000000101";
  const c2 = "0196ed00-0000-7000-8000-000000000102";
  const cArchived = "0196ed00-0000-7000-8000-000000000103";
  const cHiddenGeneral = "0196ed00-0000-7000-8000-000000000104";
  const now = new Date("2026-04-20T00:00:00Z");

  let lockedIds: string[] = [];
  let lockCalls = 0;
  let allocCalls = 0;
  let messageCreateManyCalls = 0;
  let systemMessageCreateManyCalls = 0;

  const tx = {
    conversation: {
      findMany: async () => [
        { id: c1, archivedAt: null, channelName: "eng", hiddenFromWorkspaceAt: null },
        { id: c2, archivedAt: null, channelName: "ops", hiddenFromWorkspaceAt: null },
        { id: cArchived, archivedAt: now, channelName: "old", hiddenFromWorkspaceAt: null },
        {
          id: cHiddenGeneral,
          archivedAt: null,
          channelName: "general",
          hiddenFromWorkspaceAt: now,
        },
      ],
    },
    agent: {
      findMany: async () => [{ id: AGENT_ID, name: "codex", displayName: "Codex" }],
    },
    user: {
      findMany: async () => [{ id: USER_ID, username: "alice", displayName: "Alice" }],
    },
    conversationMember: {
      findMany: async () => [
        {
          id: "0196ed00-0000-7000-8000-000000000201",
          conversationId: c1,
          userId: null,
          agentId: AGENT_ID,
        },
        {
          id: "0196ed00-0000-7000-8000-000000000202",
          conversationId: c2,
          userId: null,
          agentId: AGENT_ID,
        },
      ],
    },
    message: {
      createManyAndReturn: async (args: {
        data: Array<{ conversationId: string; sequence: number }>;
      }) => {
        messageCreateManyCalls += 1;
        return args.data.map((row, idx) => ({
          id: `0196ed00-0000-7000-8000-00000000030${idx + 1}`,
          conversationId: row.conversationId,
          sequence: row.sequence,
        }));
      },
    },
    systemMessage: {
      createMany: async () => {
        systemMessageCreateManyCalls += 1;
        return { count: 2 };
      },
    },
    $queryRaw: async (arg: unknown, param1: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("FOR NO KEY UPDATE")) {
        lockCalls += 1;
        lockedIds = Array.isArray(param1) ? (param1 as string[]) : [];
        return lockedIds.map((id) => ({ id }));
      }
      if (sql.includes('UPDATE "conversations"') && sql.includes('"lastSequence"')) {
        allocCalls += 1;
        return [
          { id: c1, sequence: 11 },
          { id: c2, sequence: 22 },
        ];
      }
      return [];
    },
  };

  const notices = await recordMembershipNotices(tx as never, {
    workspaceId: WORKSPACE_ID,
    conversationIds: [c2, cHiddenGeneral, c1, cArchived, c2],
    kind: "channel.member_removed",
    actors: [{ agentId: AGENT_ID }],
    operator: { userId: USER_ID },
  });

  expect(lockedIds).toEqual([c1, c2]);
  expect(lockCalls).toBe(1);
  expect(allocCalls).toBe(1);
  expect(messageCreateManyCalls).toBe(1);
  expect(systemMessageCreateManyCalls).toBe(1);
  expect(notices).toEqual([
    { conversationId: c1, messageId: "0196ed00-0000-7000-8000-000000000301", sequence: 11 },
    { conversationId: c2, messageId: "0196ed00-0000-7000-8000-000000000302", sequence: 22 },
  ]);
});

test("mergeLabels batches duplicate drops, single-group clash removals, history events, and task label moves", async () => {
  const fromId = "0196ed00-0000-7000-8000-000000000401";
  const intoId = "0196ed00-0000-7000-8000-000000000402";
  const clashLabelA = "0196ed00-0000-7000-8000-000000000403";
  const clashLabelB = "0196ed00-0000-7000-8000-000000000404";
  const groupId = "0196ed00-0000-7000-8000-000000000405";
  const t1 = "0196ed00-0000-7000-8000-000000000501";
  const t2 = "0196ed00-0000-7000-8000-000000000502";
  const t3 = "0196ed00-0000-7000-8000-000000000503";
  const t4 = "0196ed00-0000-7000-8000-000000000504";
  const t5 = "0196ed00-0000-7000-8000-000000000505";

  let deleteManyCalls = 0;
  let updateManyCalls = 0;
  let clashBatchDeletes = 0;
  let historyGroupByCalls = 0;
  let historyCreateManyRows: Array<{ taskId: string; seq: number }> = [];

  const tx = {
    taskLabel: {
      findMany: async (args: { where?: { labelId?: unknown } }) => {
        if (args.where?.labelId === fromId) {
          return [{ taskId: t1 }, { taskId: t2 }, { taskId: t3 }, { taskId: t4 }, { taskId: t5 }];
        }
        if (args.where?.labelId === intoId) {
          return [{ taskId: t1 }, { taskId: t2 }];
        }
        return [
          { taskId: t3, label: { id: clashLabelA, name: "P1", color: "red" } },
          { taskId: t4, label: { id: clashLabelB, name: "P2", color: "blue" } },
        ];
      },
      deleteMany: async () => {
        deleteManyCalls += 1;
        return { count: 2 };
      },
      updateMany: async () => {
        updateManyCalls += 1;
        return { count: 3 };
      },
      delete: async () => {
        throw new Error("should batch taskLabel deletes");
      },
      update: async () => {
        throw new Error("should batch taskLabel updates");
      },
    },
    taskHistoryEvent: {
      groupBy: async () => {
        historyGroupByCalls += 1;
        return [{ taskId: t3, _max: { seq: 5 } }];
      },
      createMany: async (args: { data: Array<{ taskId: string; seq: number }> }) => {
        historyCreateManyRows = args.data;
        return { count: args.data.length };
      },
      findFirst: async () => {
        throw new Error("should batch taskHistoryEvent seq lookup");
      },
      create: async () => {
        throw new Error("should batch taskHistoryEvent inserts");
      },
    },
    label: {
      delete: async () => ({ id: fromId }),
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("DELETE FROM") && sql.includes("task_labels") && sql.includes("unnest")) {
        clashBatchDeletes += 1;
      }
      return 2;
    },
  };
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "admin" }),
    },
    label: {
      findMany: async () => [
        { id: fromId, groupId: null, group: null },
        {
          id: intoId,
          groupId,
          group: { id: groupId, name: "Priority", selection: "single", required: false },
        },
      ],
    },
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };

  const result = await mergeLabels(
    db as unknown as PrismaClient,
    WORKSPACE_ID,
    USER_ID,
    fromId,
    intoId,
  );
  expect(result).toEqual({ moved: 3, dropped: 4 });
  expect(deleteManyCalls).toBe(1);
  expect(clashBatchDeletes).toBe(1);
  expect(historyGroupByCalls).toBe(1);
  expect(updateManyCalls).toBe(1);
  expect(historyCreateManyRows.map((row) => ({ taskId: row.taskId, seq: row.seq }))).toEqual([
    { taskId: t3, seq: 6 },
    { taskId: t4, seq: 1 },
  ]);
});

test("GitHubInstallationCache.replace batches multi-installation upserts into one unnest SQL statement", async () => {
  let singleUpserts = 0;
  let batchUpserts = 0;
  let batchIds: number[] = [];

  const tx = {
    gitHubUserInstallation: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => {
        singleUpserts += 1;
      },
    },
    $executeRaw: async (arg: unknown, _userId: string, _syncedAt: Date, ids: number[]) => {
      const sql = sqlText(arg);
      if (
        sql.includes("github_user_installations") &&
        sql.includes("unnest") &&
        sql.includes("::timestamp(3)")
      ) {
        batchUpserts += 1;
        batchIds = ids;
      }
      return ids.length;
    },
  };
  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };

  const cache = new GitHubInstallationCache(
    db as unknown as PrismaClient,
    {} as never,
    { appId: 1, installUrl: "https://github.com/apps/coforge" },
    () => Date.parse("2026-04-20T00:00:00Z"),
  );
  await cache.replace(USER_ID, [
    {
      id: 30,
      login: "org-c",
      repositorySelection: "all",
      suspended: false,
      configureUrl: "https://github.com/30",
    },
    {
      id: 10,
      login: "org-a",
      repositorySelection: "selected",
      suspended: true,
      configureUrl: "https://github.com/10",
    },
    {
      id: 30,
      login: "org-c-new",
      repositorySelection: "selected",
      suspended: false,
      configureUrl: "https://github.com/30",
    },
  ]);

  expect(singleUpserts).toBe(0);
  expect(batchUpserts).toBe(1);
  expect(batchIds).toEqual([10, 30]);
});

test("ChatSections.reorder and move batch sortOrder updates via unnest instead of per-row update loops", async () => {
  const s1 = "0196ed00-0000-7000-8000-000000000601";
  const s2 = "0196ed00-0000-7000-8000-000000000602";
  const s3 = "0196ed00-0000-7000-8000-000000000603";
  const c1 = "0196ed00-0000-7000-8000-000000000611";
  const c2 = "0196ed00-0000-7000-8000-000000000612";
  const c3 = "0196ed00-0000-7000-8000-000000000613";
  const m1 = "0196ed00-0000-7000-8000-000000000621";
  const m2 = "0196ed00-0000-7000-8000-000000000622";
  const m3 = "0196ed00-0000-7000-8000-000000000623";

  let sectionSingleUpdates = 0;
  let sectionBatchUpdates = 0;
  let memberSingleUpdates = 0;
  let memberBatchUpdates = 0;

  const tx = {
    chatSection: {
      findMany: async () => [{ id: s1 }, { id: s2 }, { id: s3 }],
      findFirst: async () => ({ id: s1 }),
      update: async (args: { data: { sortOrder?: number } }) => {
        if (args.data.sortOrder !== undefined) sectionSingleUpdates += 1;
        return {};
      },
    },
    conversationMember: {
      findFirst: async () => ({ id: m3, hiddenAt: null, conversation: { channelName: "eng" } }),
      findMany: async () => [
        { id: m1, conversationId: c1 },
        { id: m2, conversationId: c2 },
      ],
      update: async () => {
        memberSingleUpdates += 1;
        return {};
      },
    },
    conversationPin: {
      deleteMany: async () => ({ count: 0 }),
    },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("workspace_memberships")) return [{ ok: 1 }];
      return [];
    },
    $executeRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("chat_sections") && sql.includes("unnest")) sectionBatchUpdates += 1;
      if (sql.includes("conversation_members") && sql.includes("unnest")) memberBatchUpdates += 1;
      return 3;
    },
  };
  const db = {
    workspaceMembership: { findUnique: async () => ({ userId: USER_ID }) },
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };

  const sections = new ChatSections(db as unknown as PrismaClient, WORKSPACE_ID, USER_ID);
  await sections.reorder([s3, s1, s2]);
  expect(sectionSingleUpdates).toBe(0);
  expect(sectionBatchUpdates).toBe(1);

  await sections.move(c3, s1, c2);
  expect(memberSingleUpdates).toBe(1);
  expect(memberBatchUpdates).toBe(1);
});

test("deleteAttachmentRows batches conversation locking via lockConversations instead of per-id loops", async () => {
  const c1 = "0196ed00-0000-7000-8000-000000000701";
  const c2 = "0196ed00-0000-7000-8000-000000000702";
  const t1 = "0196ed00-0000-7000-8000-000000000703";
  const t2 = "0196ed00-0000-7000-8000-000000000704";

  let lockQueries = 0;
  const tx = {
    attachment: {
      findMany: async () => [
        { conversationId: c2, objectKey: "k1" },
        { conversationId: c1, objectKey: "k2" },
        { conversationId: c2, objectKey: "k3" },
      ],
      deleteMany: async () => ({ count: 3 }),
    },
    attachmentCommentThread: {
      findMany: async () => [{ conversationId: t2 }, { conversationId: t1 }],
    },
    message: { deleteMany: async () => ({ count: 0 }) },
    conversation: { deleteMany: async () => ({ count: 2 }) },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("FOR NO KEY UPDATE")) lockQueries += 1;
      return [];
    },
  };
  const db = {
    $transaction: async <T>(fn: (txClient: unknown) => Promise<T>) => fn(tx),
  };

  const deleted = await deleteAttachmentRows(db as unknown as PrismaClient, {
    workspaceId: WORKSPACE_ID,
  });
  expect(deleted.objectKeys).toEqual(["k1", "k2", "k3"]);
  expect(lockQueries).toBe(2);
});

test("DaemonCredentialRevocations.recordForComputerWorkspaces batches multi-workspace revocations into 1 lookup, 1 prune, and 1 createMany", async () => {
  let keyLookups = 0;
  let prunes = 0;
  let createManyCalls = 0;

  const tx = {
    daemonApiKey: {
      findMany: async () => {
        keyLookups += 1;
        return [{ apiKeyHash: "h1" }, { apiKeyHash: "h2" }, { apiKeyHash: "h3" }];
      },
    },
    daemonCredentialRevocation: {
      deleteMany: async () => {
        prunes += 1;
        return { count: 0 };
      },
      createMany: async () => {
        createManyCalls += 1;
        return { count: 3 };
      },
    },
  };

  const count = await DaemonCredentialRevocations.recordForComputerWorkspaces(tx as never, {
    workspaceIds: [
      "0196ed00-0000-7000-8000-000000000801",
      "0196ed00-0000-7000-8000-000000000802",
      "0196ed00-0000-7000-8000-000000000803",
    ],
    computerId: COMPUTER_ID,
  });

  expect(count).toBe(3);
  expect(keyLookups).toBe(1);
  expect(prunes).toBe(1);
  expect(createManyCalls).toBe(1);
});
