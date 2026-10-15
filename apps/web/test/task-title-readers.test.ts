import { describe, expect, test } from "bun:test";

import { historyEventView, taskChanges } from "#src/server/tasks/task-history.server";
import { taskView, type SelectedTask } from "#src/server/tasks/task-view.server";

const GRACE_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const graceMention = {
  kind: "user",
  actorId: GRACE_ID,
  handle: "grace-hopper-4k2",
  member: { user: { displayName: "Grace Hopper" }, agent: null },
};

function task(title: string, revision = 1): SelectedTask {
  const creator = {
    id: "member-1",
    userId: "user-1",
    agentId: null,
    leftAt: null,
    user: { username: "ada-9d3", displayName: "Ada", avatarObjectKey: null },
    agent: null,
  };
  return {
    messageId: "message-1",
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    number: 4,
    title,
    description: "",
    createsResource: false,
    resourceReceipt: null,
    resourceReceiptRecordedAt: null,
    status: "todo",
    revision,
    claimedAt: null,
    createdAt: new Date("2026-10-15T00:00:00Z"),
    updatedAt: new Date("2026-10-15T00:00:00Z"),
    ownerMemberId: null,
    owner: null,
    creator,
    executionSessions: [],
    message: { sequence: 1, mentions: [graceMention] },
  } as unknown as SelectedTask;
}

const converted = `Ask <@human:${GRACE_ID}> about the deploy`;

describe("a Task's title", () => {
  test("names a mentioned person for people, and keeps the @handle for an Agent", () => {
    expect(taskView(task(converted)).title).toBe("Ask @Grace Hopper about the deploy");
    expect(taskView(task(converted), "people").title).toBe("Ask @Grace Hopper about the deploy");
    expect(taskView(task(converted), "agent").title).toBe("Ask @grace-hopper-4k2 about the deploy");
  });
});

describe("a title change in a Task's history", () => {
  const amended = () => {
    const [change] = taskChanges(task(converted), task(`${converted} today`, 2));
    return {
      id: "event-1",
      taskMessageId: "message-1",
      seq: 1,
      actorType: "user",
      actorName: "ada-9d3",
      createdAt: new Date("2026-10-15T00:00:00Z"),
      eventType: change!.eventType,
      payload: change!.payload,
    };
  };

  test("is recorded with its tokens, never as a username", () => {
    expect(JSON.stringify(amended().payload)).not.toContain("grace-hopper-4k2");
  });

  test("reads back by name for people and by @handle for an Agent", () => {
    const people = historyEventView(amended(), "people", [graceMention]);
    expect(people.payload).toMatchObject({
      changes: {
        title: {
          from: "Ask @Grace Hopper about the deploy",
          to: "Ask @Grace Hopper about the deploy today",
        },
      },
    });
    const agent = historyEventView(amended(), "agent", [graceMention]);
    expect(agent.payload).toMatchObject({
      changes: { title: { from: "Ask @grace-hopper-4k2 about the deploy" } },
    });
  });

  test("an older record written as plain text reads as it was written", () => {
    const event = {
      ...amended(),
      payload: { changes: { title: { from: "a", to: "b" } }, revision: 2 },
    };
    expect(historyEventView(event, "people", [graceMention]).payload).toMatchObject({
      changes: { title: { from: "a", to: "b" } },
    });
  });
});
