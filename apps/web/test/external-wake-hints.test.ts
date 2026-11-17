import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { listWakeHints } from "#src/server/agents/external-wake-hints.server";

type Row = {
  conversationId: string;
  threadRootId: string | null;
  pendingCount: number;
  firstPendingMsgId: string;
  latestMsgId: string;
  latestSeq: number;
  latestSenderName: string | null;
  latestSenderType: "human" | "agent" | "system";
  mentioned: boolean;
};

function fakeDb(rows: Row[], conversations: Record<string, unknown>[]) {
  const queries: string[] = [];
  const db = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return rows;
    },
    conversation: { findMany: async () => conversations },
    user: { findMany: async () => [] },
    workspaceMembership: { findMany: async () => [] },
    agent: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return { db, queries };
}

const row = (over: Partial<Row> = {}): Row => ({
  conversationId: "c1",
  threadRootId: null,
  pendingCount: 2,
  firstPendingMsgId: "m1",
  latestMsgId: "m2",
  latestSeq: 7,
  latestSenderName: "ada",
  latestSenderType: "human",
  mentioned: false,
  ...over,
});

const channel = (id: string, channelName: string) => ({
  id,
  kind: null,
  channelName,
  directKey: null,
  attachmentCommentThread: null,
  members: [],
  taskDiscussionOf: null,
});

test("a channel with unread becomes one hint, from one grouped statement", async () => {
  const { db, queries } = fakeDb([row({ mentioned: true })], [channel("c1", "general")]);
  const hints = await listWakeHints(db, { workspaceId: "w", agentId: "a" });
  expect(hints).toEqual([
    {
      target: "#general",
      channelId: "c1",
      channelType: "channel",
      pendingCount: 2,
      firstPendingMsgId: "m1",
      latestMsgId: "m2",
      latestSeq: "7",
      latestSenderName: "ada",
      latestSenderType: "human",
      flags: ["mention"],
    },
  ]);
  expect(queries).toHaveLength(1);
});

test("a thread reply group keeps its own target and carries the thread flag", async () => {
  const { db } = fakeDb(
    [row({ threadRootId: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" })],
    [channel("c1", "general")],
  );
  const [hint] = await listWakeHints(db, { workspaceId: "w", agentId: "a" });
  expect(hint!.target).toBe("#general:0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee");
  expect(hint!.flags).toEqual(["thread"]);
});

test("a conversation the lookup cannot name has a null target", async () => {
  const { db } = fakeDb([row()], [{ ...channel("c1", "x"), channelName: null }]);
  const [hint] = await listWakeHints(db, { workspaceId: "w", agentId: "a" });
  expect(hint!.target).toBeNull();
  expect(hint!.channelType).toBe("dm");
  expect(hint!.flags).toEqual(["dm"]);
});

test("no unread rows means no hints and no lookups", async () => {
  const { db } = fakeDb([], []);
  expect(await listWakeHints(db, { workspaceId: "w", agentId: "a" })).toEqual([]);
});
