import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  AGENT_REMINDER_PAGE_SIZE,
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
  type AgentReminderReadStore,
} from "#src/server/agents/agent-reminders.server";
import { withFakePagination } from "./helpers/fake-paginated";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const item = (id: string) => ({
  id,
  title: `Reminder ${id}`,
  fireAt: "2026-09-10T10:00:00.000Z",
  repeat: null,
  timezone: null,
  target: "@owner",
  createdAt: "2026-09-09T10:00:00.000Z",
  anchor: {
    kind: "direct" as const,
    conversationId: "dm-1",
    messageId: "message-1",
    threadRootId: null,
  },
});

function store(overrides: Partial<AgentReminderReadStore> = {}): AgentReminderReadStore {
  return {
    ownsAgent: async () => true,
    list: async () => ({ reminders: [], hasMore: false }),
    ...overrides,
  };
}

test("does not query reminders when the viewer does not own the Agent in the Workspace", async () => {
  let read = false;
  const query = new AgentRemindersQuery(
    store({
      ownsAgent: async () => false,
      list: async () => {
        read = true;
        return { reminders: [], hasMore: false };
      },
    }),
  );
  expect(await query.list(viewer, { agentId: "other-agent" })).toEqual({ status: "unauthorized" });
  expect(read).toBeFalse();
});

test("returns a bounded page and stable explicit cursor", async () => {
  let limit = 0;
  const query = new AgentRemindersQuery(
    store({
      list: async (input) => {
        limit = input.limit;
        return {
          reminders: Array.from({ length: 50 }, (_, index) => item(`id-${index}`)),
          hasMore: true,
        };
      },
    }),
  );
  const result = await query.list(viewer, { agentId: "agent-1" });
  expect(limit).toBe(AGENT_REMINDER_PAGE_SIZE);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("expected ready result");
  expect(result.reminders).toHaveLength(50);
  expect(result.cursor).toEqual({ id: "id-49" });
  expect(result.hasMore).toBeTrue();
});

test("exposes targets and derives readable message anchors from the canonical conversation", async () => {
  const reminder = (id: string, messageId: string) => ({
    id,
    title: id,
    fireAt: new Date("2026-09-10T10:00:00Z"),
    repeat: null,
    timezone: null,
    createdAt: new Date("2026-09-09T10:00:00Z"),
    messageId,
    target: id === "public-channel" ? "#general" : "@owner",
  });
  const db = withFakePagination({
    reminder: {
      findMany: async () => [
        reminder("owned-dm", "message-owned-dm"),
        reminder("other-dm", "message-other-dm"),
        reminder("public-channel", "message-channel-reply"),
      ],
    },
    message: {
      findMany: async () => [
        {
          id: "message-owned-dm",
          threadRootId: null,
          conversation: {
            id: "owned-conversation",
            channelName: null,
            members: [
              { userId: "user-1", agentId: null },
              { userId: null, agentId: "agent-1" },
            ],
          },
        },
        {
          id: "message-other-dm",
          threadRootId: null,
          conversation: {
            id: "other-conversation",
            channelName: null,
            members: [
              { userId: "user-2", agentId: null },
              { userId: null, agentId: "agent-1" },
            ],
          },
        },
        {
          id: "message-channel-reply",
          threadRootId: "channel-root",
          conversation: {
            id: "channel-1",
            channelName: "general",
            members: [],
          },
        },
      ],
    },
  }) as unknown as PrismaClient;

  const { reminders: rows } = await prismaAgentReminderReadStore(db).list({
    viewer,
    agentId: "agent-1",
    limit: 50,
  });
  expect(rows.map((row) => row.anchor)).toEqual([
    {
      kind: "direct",
      conversationId: "owned-conversation",
      messageId: "message-owned-dm",
      threadRootId: null,
    },
    null,
    {
      kind: "channel",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-channel-reply",
      threadRootId: "channel-root",
    },
  ]);
  expect(rows.map((row) => row.target)).toEqual(["@owner", "@owner", "#general"]);
  expect(rows[2]?.anchor).toMatchObject({ channelName: "general" });
});

test("filters scheduled reminders in the database before cursor pagination", async () => {
  const seeded = [
    { id: "future", status: "scheduled", fireAt: new Date("2026-09-10T10:00:00Z"), firedAt: null },
    {
      id: "recurring",
      status: "scheduled",
      fireAt: new Date("2026-09-10T11:00:00Z"),
      firedAt: new Date("2026-09-09T11:00:00Z"),
    },
    { id: "overdue", status: "scheduled", fireAt: new Date("2026-09-08T10:00:00Z"), firedAt: null },
    { id: "fired", status: "fired", fireAt: new Date("2026-09-07T10:00:00Z"), firedAt: null },
    { id: "canceled", status: "canceled", fireAt: new Date("2026-09-06T10:00:00Z"), firedAt: null },
  ];
  const findManyInputs: Record<string, unknown>[] = [];
  const db = withFakePagination({
    reminder: {
      findMany: async (input: {
        where: { status: string };
        cursor: { id: string };
        skip: number;
        take: number;
      }) => {
        findManyInputs.push(input);
        return seeded
          .filter((row) => row.status === input.where.status)
          .slice(0, input.take)
          .map((row) => ({
            ...row,
            title: row.id,
            repeat: row.id === "recurring" ? "daily@09:30" : null,
            timezone: null,
            createdAt: row.fireAt,
            messageId: `message-${row.id}`,
            target: "ignored",
          }));
      },
    },
    message: { findMany: async () => [] },
  }) as unknown as PrismaClient;

  const { reminders: rows } = await prismaAgentReminderReadStore(db).list({
    viewer,
    agentId: "agent-1",
    cursor: { id: "before-50" },
    limit: 50,
  });

  // The page itself: after the cursor row, one more than the page to learn whether another exists.
  // (The extension's other read is its `hasPreviousPage` probe: `take: -1` from the cursor.)
  const page = findManyInputs.find((input) => input.skip === 1);
  if (!page) throw new Error("expected the reminder page query");
  expect((page.where as { status?: string }).status).toBe("scheduled");
  expect(page.cursor).toEqual({ id: "before-50" });
  expect(page.take).toBe(51);
  expect(page.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  expect(rows.map((row) => row.id)).toEqual(["future", "recurring", "overdue"]);
});
