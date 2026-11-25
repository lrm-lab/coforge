import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import { listOwnTasks, showTask } from "#src/server/tasks/task-list.server";
import { overviewRow, overviewSelection } from "#src/server/tasks/task-overview-row.server";
import { TaskOverviewReads } from "#src/server/tasks/task-overview.server";
import { emptyRelations } from "#src/server/tasks/task-view.server";

type OverviewRowInput = Parameters<typeof overviewRow>[0];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function baseTaskRow<T extends Record<string, unknown>>(overrides?: T) {
  const now = new Date("2026-11-24T00:00:00.000Z");
  return {
    id: "task-1",
    messageId: "msg-1",
    conversationId: "conv-1",
    workspaceId: "ws-1",
    number: 1,
    title: "Fix latency",
    description: "Details",
    createsResource: false,
    resourceReceipt: null,
    resourceReceiptRecordedAt: null,
    status: "todo",
    priority: "medium",
    dueAt: null,
    dueHasTime: false,
    revision: 1,
    claimedAt: null,
    createdAt: now,
    updatedAt: now,
    ownerMemberId: null,
    sourceMessageId: null,
    discussionConversationId: "disc-1",
    owner: null,
    creator: {
      id: "member-creator",
      userId: "user-1",
      agentId: null,
      leftAt: null,
      user: { username: "frank", displayName: "Frank", avatarObjectKey: null },
      agent: null,
    },
    labels: [],
    project: null,
    executionSessions: [],
    message: { sequence: 1, mentions: [] },
    sourceMessage: null,
    ...overrides,
  };
}

function overviewRowInput(conversation: OverviewRowInput["conversation"]): OverviewRowInput {
  return {
    ...baseTaskRow(),
    conversation,
  };
}

describe("overviewSelection and overviewRow", () => {
  test("selects only viewer membership and DM members, never all channel agents", () => {
    const selection = overviewSelection("user-1");
    expect(selection.conversation.select.members.where).toEqual({
      OR: [{ userId: "user-1" }, { conversation: { channelName: null } }],
    });
  });

  test("resolves source and currentMemberId for channels, user-agent DMs, user-user DMs, and self-DMs", () => {
    const extras = { relations: emptyRelations() };

    const channelRow = overviewRow(
      overviewRowInput({
        channelName: "general",
        visibility: "public",
        members: [
          {
            id: "member-viewer",
            userId: "user-1",
            agent: null,
            user: { id: "user-1", displayName: "Frank", username: "frank" },
          },
        ],
      }),
      "user-1",
      extras,
    );
    expect(channelRow.currentMemberId).toBe("member-viewer");
    expect(channelRow.source).toEqual({
      channelName: "general",
      agentId: null,
      label: "#general",
    });

    const nonMemberChannelRow = overviewRow(
      overviewRowInput({
        channelName: "general",
        visibility: "public",
        members: [],
      }),
      "user-1",
      extras,
    );
    expect(nonMemberChannelRow.currentMemberId).toBeNull();
    expect(nonMemberChannelRow.source).toEqual({
      channelName: "general",
      agentId: null,
      label: "#general",
    });

    const agentDmRow = overviewRow(
      overviewRowInput({
        channelName: null,
        visibility: "public",
        members: [
          {
            id: "member-viewer",
            userId: "user-1",
            agent: null,
            user: { id: "user-1", displayName: "Frank", username: "frank" },
          },
          {
            id: "member-agent",
            userId: null,
            agent: { id: "agent-1", name: "atlas", displayName: "Atlas" },
            user: null,
          },
        ],
      }),
      "user-1",
      extras,
    );
    expect(agentDmRow.currentMemberId).toBe("member-viewer");
    expect(agentDmRow.source).toEqual({
      channelName: null,
      agentId: "agent-1",
      label: "Atlas",
    });

    const peerDmRow = overviewRow(
      overviewRowInput({
        channelName: null,
        visibility: "public",
        members: [
          {
            id: "member-viewer",
            userId: "user-1",
            agent: null,
            user: { id: "user-1", displayName: "Frank", username: "frank" },
          },
          {
            id: "member-peer",
            userId: "user-2",
            agent: null,
            user: { id: "user-2", displayName: "Alice", username: "alice" },
          },
        ],
      }),
      "user-1",
      extras,
    );
    expect(peerDmRow.source).toEqual({
      channelName: null,
      agentId: null,
      label: "Alice",
    });

    const selfDmRow = overviewRow(
      overviewRowInput({
        channelName: null,
        visibility: "public",
        members: [
          {
            id: "member-viewer",
            userId: "user-1",
            agent: null,
            user: { id: "user-1", displayName: "Frank", username: "frank" },
          },
        ],
      }),
      "user-1",
      extras,
    );
    expect(selfDmRow.source).toEqual({
      channelName: null,
      agentId: null,
      label: "Frank",
    });
  });
});

describe("listOwnTasks", () => {
  test("restricts conversation.members selection to direct conversations only", async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const db = {
      task: {
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          return [
            baseTaskRow({
              id: "task-channel",
              conversation: { channelName: "general", members: [] },
            }),
            baseTaskRow({
              id: "task-dm",
              number: 2,
              conversationId: "conv-dm",
              conversation: {
                channelName: null,
                members: [{ user: { username: "frank" } }],
              },
            }),
          ];
        },
      },
      taskDependency: { findMany: async () => [] },
      taskParent: { findMany: async () => [] },
      $queryRaw: async () => [],
    } as unknown as PrismaClient;

    const result = await listOwnTasks(
      { db, reader: "agent", dependencies: {} },
      { workspaceId: "ws-1", agentId: "agent-1" },
      { operation: "list", idempotencyKey: "req-1", mine: true },
    );

    expect(findManyCalls).toHaveLength(1);
    const select = findManyCalls[0]!.select as {
      conversation: { select: { members: { where: unknown } } };
    };
    expect(select.conversation.select.members.where).toEqual({
      userId: { not: null },
      conversation: { channelName: null },
    });
    expect(result.tasks?.map((task) => task.channelRef)).toEqual(["#general", "@frank"]);
  });
});

describe("concurrent viewsWithCounts and showRelations", () => {
  test("showTask starts viewsWithCounts and showRelations concurrently", async () => {
    const blockerStarted = deferred<void>();
    const blockerQuery = deferred<unknown[]>();
    const dependentQuery = deferred<unknown[]>();
    let dependentQueryStarted = false;

    const db = {
      task: {
        findFirst: async () => baseTaskRow(),
      },
      taskDependency: {
        findMany: (args: { where: Record<string, unknown> }) => {
          if ("blockedByTaskId" in args.where) {
            dependentQueryStarted = true;
            return dependentQuery.promise;
          }
          blockerStarted.resolve();
          return blockerQuery.promise;
        },
      },
      taskParent: { findMany: async () => [] },
      $queryRaw: async () => [],
    } as unknown as PrismaClient;

    const pending = showTask({ db, reader: "agent", dependencies: {} }, "ws-1", "conv-1", {
      operation: "show",
      idempotencyKey: "req-2",
      number: 1,
    });

    try {
      await blockerStarted.promise;
      expect(dependentQueryStarted).toBe(true);
    } finally {
      blockerQuery.resolve([]);
      dependentQuery.resolve([]);
    }
    const result = await pending;
    expect(result.tasks).toHaveLength(1);
    expect(result.blocking).toEqual([]);
    expect(result.subtree).toEqual([]);
  });

  test("overviewTask starts viewsWithCounts and showRelations concurrently", async () => {
    const blockerStarted = deferred<void>();
    const blockerQuery = deferred<unknown[]>();
    const dependentQuery = deferred<unknown[]>();
    let dependentQueryStarted = false;

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ userId: "user-1" }),
      },
      task: {
        findFirst: async () =>
          overviewRowInput({
            channelName: "general",
            visibility: "public",
            members: [],
          }),
      },
      taskDependency: {
        findMany: (args: { where: Record<string, unknown> }) => {
          if ("blockedByTaskId" in args.where) {
            dependentQueryStarted = true;
            return dependentQuery.promise;
          }
          blockerStarted.resolve();
          return blockerQuery.promise;
        },
      },
      taskParent: { findMany: async () => [] },
      $queryRaw: async () => [],
    } as unknown as PrismaClient;

    const reads = new TaskOverviewReads(db, {
      listableConversation: async () => "conv-1",
    });

    const pending = reads.overviewTask(
      { workspaceId: "ws-1", userId: "user-1" },
      { conversationId: "conv-1", number: 1 },
    );

    try {
      await blockerStarted.promise;
      expect(dependentQueryStarted).toBe(true);
    } finally {
      blockerQuery.resolve([]);
      dependentQuery.resolve([]);
    }
    const task = await pending;
    expect(task?.source.label).toBe("#general");
    expect(task?.blocking).toEqual([]);
    expect(task?.subtree).toEqual([]);
  });
});

describe("finishedSummary", () => {
  test("skips empty owner and project lookups and deduplicates owner ids", async () => {
    const memberCalls: Array<{ where: { id: { in: string[] } } }> = [];
    const projectCalls: Array<{ where: { id: { in: string[] } } }> = [];
    let groupedRows: Array<{
      status: string;
      ownerMemberId: string | null;
      projectId: string | null;
      _count: { _all: number };
    }> = [];

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ userId: "user-1" }),
      },
      task: {
        groupBy: async () => groupedRows,
      },
      conversationMember: {
        findMany: async (args: { where: { id: { in: string[] } } }) => {
          memberCalls.push(args);
          return [
            {
              id: "member-1",
              userId: "user-1",
              agentId: null,
              leftAt: null,
              user: { username: "frank", displayName: "Frank", avatarObjectKey: null },
              agent: null,
            },
          ];
        },
      },
      project: {
        findMany: async (args: { where: { id: { in: string[] } } }) => {
          projectCalls.push(args);
          return [{ id: "proj-1", name: "Core", slug: "core" }];
        },
      },
    } as unknown as PrismaClient;

    const reads = new TaskOverviewReads(db, {
      listableConversation: async () => "conv-1",
    });

    groupedRows = [];
    expect(
      await reads.finishedSummary({ workspaceId: "ws-1", userId: "user-1" }, { window: "week" }),
    ).toEqual({
      groups: [],
    });
    expect(memberCalls).toHaveLength(0);
    expect(projectCalls).toHaveLength(0);

    groupedRows = [{ status: "done", ownerMemberId: null, projectId: null, _count: { _all: 3 } }];
    const unassigned = await reads.finishedSummary(
      { workspaceId: "ws-1", userId: "user-1" },
      { window: "week" },
    );
    expect(unassigned.groups).toHaveLength(1);
    expect(memberCalls).toHaveLength(0);
    expect(projectCalls).toHaveLength(0);

    groupedRows = [
      { status: "done", ownerMemberId: "member-1", projectId: "proj-1", _count: { _all: 2 } },
      { status: "closed", ownerMemberId: "member-1", projectId: "proj-1", _count: { _all: 1 } },
    ];
    const populated = await reads.finishedSummary(
      { workspaceId: "ws-1", userId: "user-1" },
      { window: "week" },
    );
    expect(populated.groups).toHaveLength(2);
    expect(memberCalls).toHaveLength(1);
    expect(memberCalls[0]!.where.id.in).toEqual(["member-1"]);
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0]!.where.id.in).toEqual(["proj-1"]);
  });
});
