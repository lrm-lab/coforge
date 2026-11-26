import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { viewsWithCounts } from "#src/server/tasks/task-discussion-counts.server";
import { overviewSelection } from "#src/server/tasks/task-overview-row.server";
import {
  latestExecutionSessions,
  taskViewOf,
  taskViewsOf,
} from "#src/server/tasks/task-relations.server";
import { taskSelection, taskView, type SelectedTask } from "#src/server/tasks/task-view.server";

function sqlText(arg: unknown): string {
  if (Array.isArray(arg)) return arg.join(" ");
  if (arg && typeof arg === "object" && "strings" in arg && Array.isArray(arg.strings))
    return (arg.strings as string[]).join(" ");
  return String(arg ?? "");
}

function makeTask(id: string, number: number): SelectedTask {
  return {
    id,
    messageId: `msg-${number}`,
    conversationId: "0196ed00-0000-7000-8000-000000000010",
    workspaceId: "0196ed00-0000-7000-8000-000000000001",
    number,
    title: `Task ${number}`,
    description: "",
    createsResource: false,
    resourceReceipt: null,
    resourceReceiptRecordedAt: null,
    status: "in_progress",
    priority: "none",
    dueAt: null,
    dueHasTime: false,
    revision: 1,
    claimedAt: null,
    createdAt: new Date("2026-11-20T00:00:00.000Z"),
    updatedAt: new Date("2026-11-20T00:00:00.000Z"),
    ownerMemberId: null,
    sourceMessageId: null,
    discussionConversationId: null,
    owner: null,
    creator: {
      id: "member-1",
      userId: "user-1",
      agentId: null,
      leftAt: null,
      user: { username: "ada", displayName: "Ada", avatarObjectKey: null },
      agent: null,
    },
    labels: [],
    project: null,
    message: { sequence: number, mentions: [] },
    sourceMessage: null,
  } as unknown as SelectedTask;
}

test("taskSelection and overviewSelection do not include nested executionSessions take:1", () => {
  expect("executionSessions" in taskSelection).toBe(false);
  expect("executionSessions" in overviewSelection("user-1")).toBe(false);
});

test("latestExecutionSessions runs 0 queries for empty input and 1 DISTINCT ON batched query for multiple tasks", async () => {
  const queries: string[] = [];
  const db = {
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      queries.push(sql);
      return [
        { taskId: "0196ed00-0000-7000-8000-000000000101", id: "sess-1" },
        { taskId: "0196ed00-0000-7000-8000-000000000102", id: "sess-2" },
      ];
    },
  } as unknown as PrismaClient;

  expect(await latestExecutionSessions(db, [])).toEqual(new Map());
  expect(queries).toHaveLength(0);

  const map = await latestExecutionSessions(db, [
    { id: "0196ed00-0000-7000-8000-000000000101" },
    { id: "0196ed00-0000-7000-8000-000000000102" },
    { id: "0196ed00-0000-7000-8000-000000000101" },
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("DISTINCT ON");
  expect(queries[0]).toContain("task_execution_sessions");
  expect(map.get("0196ed00-0000-7000-8000-000000000101")).toBe("sess-1");
  expect(map.get("0196ed00-0000-7000-8000-000000000102")).toBe("sess-2");
});

test("viewsWithCounts, taskViewOf, and taskViewsOf populate executionSessionId from batched lookup", async () => {
  const t1 = makeTask("0196ed00-0000-7000-8000-000000000101", 1);
  const t2 = makeTask("0196ed00-0000-7000-8000-000000000102", 2);
  let sessionQueries = 0;

  const db = {
    taskDependency: { findMany: async () => [] },
    taskParent: { findMany: async () => [] },
    $queryRaw: async (arg: unknown) => {
      const sql = sqlText(arg);
      if (sql.includes("task_execution_sessions")) {
        sessionQueries += 1;
        return [{ taskId: t1.id, id: "sess-latest-1" }];
      }
      return [];
    },
  } as unknown as PrismaClient;

  const withCounts = await viewsWithCounts(
    db,
    "people",
    "0196ed00-0000-7000-8000-000000000001",
    [t1, t2],
    (task, extras) => taskView(task, "people", extras),
  );
  expect(sessionQueries).toBe(1);
  expect(withCounts.map((v) => v.executionSessionId)).toEqual(["sess-latest-1", null]);

  const single = await taskViewOf(db, "people", t1);
  expect(single.executionSessionId).toBe("sess-latest-1");

  const multi = await taskViewsOf(db, "agent", [t1, t2]);
  expect(multi.map((v) => v.executionSessionId)).toEqual(["sess-latest-1", null]);
});
