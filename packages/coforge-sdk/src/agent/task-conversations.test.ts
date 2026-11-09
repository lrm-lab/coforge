import { expect, test } from "bun:test";
import { agentApiRoutes } from "./routes";
import type { AgentTaskIdleItem } from "./task-conversations";
import {
  decodeAgentTaskFollowResponse,
  decodeAgentTaskFollowingResponse,
  decodeAgentTaskIdleNudgeResponse,
  decodeAgentTaskReplyResponse,
  decodeAgentTaskViewResponse,
  taskConversationHttpRequest,
} from "./task-conversations";

const routes = agentApiRoutes.cloud.taskConversations;

test("a GET carries its query on the route's path, a POST its body", () => {
  expect(
    taskConversationHttpRequest(routes, {
      route: "view",
      query: { channel: "#general", task_number: "7", limit: "5" },
    }),
  ).toEqual({
    method: "GET",
    path: "/api/agent/v1/tasks/view?channel=%23general&task_number=7&limit=5",
  });
  expect(taskConversationHttpRequest(routes, { route: "following" })).toEqual({
    method: "GET",
    path: "/api/agent/v1/tasks/following",
  });
  expect(
    taskConversationHttpRequest(routes, {
      route: "follow",
      body: { channel: "#general", task_number: 7 },
    }),
  ).toEqual({
    method: "POST",
    path: "/api/agent/v1/tasks/follow",
    body: JSON.stringify({ channel: "#general", task_number: 7 }),
  });
});

const VIEW = {
  taskRef: "#general:#7",
  task: { id: "t1", number: 7, title: "Fix it", status: "todo" },
  following: true,
  followReason: "manual",
  conversation: { exists: true, replyCount: 1 },
  recentMessages: [
    { id: "m1", sequence: 1, body: "hi", createdAt: "2026-10-30T10:00:00.000Z", sender: "ada" },
    { id: "m2", sequence: 2, body: "notice", createdAt: "2026-10-30T10:01:00.000Z", sender: null },
  ],
  hasOlder: false,
};

test("decodes a task view, a reply, a follow change and the followed list", () => {
  expect(decodeAgentTaskViewResponse(VIEW)).toEqual(VIEW);
  expect(
    decodeAgentTaskReplyResponse({ messageId: "m3", sequence: 3, idempotencyKey: "k" }),
  ).toEqual({ messageId: "m3", sequence: 3, idempotencyKey: "k" });
  const follow = { ok: true as const, taskRef: "#general:#7", following: false, changed: true };
  expect(decodeAgentTaskFollowResponse(follow)).toEqual(follow);
  const row = {
    taskRef: "#general:#7",
    taskNumber: 7,
    title: "Fix it",
    status: "todo",
    unread: 2,
    followedAt: "2026-10-30T10:00:00.000Z",
    reason: "assigned",
  };
  expect(decodeAgentTaskFollowingResponse({ tasks: [row] })).toEqual({ tasks: [row] });
});

test("an idle-nudge item carries its queue place when the server numbers one (task #716)", () => {
  const item: AgentTaskIdleItem = {
    ref: "#general:#7",
    taskNumber: 7,
    channel: "#general",
    title: "Fix it",
    status: "todo",
    priority: "high",
    reason: "newly_assigned",
    why: "newly assigned to you",
  };
  const response = { send: true, items: [item], backlog: [], text: "reminder" };
  // A server that predates queue numbering sends no queuePosition; one that numbers sends it.
  expect(decodeAgentTaskIdleNudgeResponse(response)).toEqual(response);
  const queued = { ...item, queuePosition: 2 };
  expect(decodeAgentTaskIdleNudgeResponse({ ...response, items: [queued] })).toEqual({
    ...response,
    items: [queued],
  });
  expect(() =>
    decodeAgentTaskIdleNudgeResponse({
      ...response,
      items: [{ ...item, queuePosition: "2" }],
    }),
  ).toThrow("invalid Agent task idle-nudge response");
  // Positions are 1-based integers; anything else is a broken server, not a reminder to pass on.
  for (const queuePosition of [0, -1, 1.5, Number.NaN])
    expect(() =>
      decodeAgentTaskIdleNudgeResponse({
        ...response,
        items: [{ ...item, queuePosition }],
      }),
    ).toThrow("invalid Agent task idle-nudge response");
});

test("refuses responses of the wrong shape", () => {
  expect(() => decodeAgentTaskViewResponse({ ...VIEW, recentMessages: "x" })).toThrow(
    "invalid Agent task view response",
  );
  expect(() => decodeAgentTaskReplyResponse({ sequence: 3 })).toThrow(
    "invalid Agent task reply response",
  );
  expect(() => decodeAgentTaskFollowResponse({ ok: true, taskRef: "#a:#1" })).toThrow(
    "invalid Agent task follow response",
  );
  expect(() => decodeAgentTaskFollowingResponse({ tasks: [{ taskRef: 1 }] })).toThrow(
    "invalid Agent followed tasks response",
  );
  expect(() => decodeAgentTaskFollowingResponse(undefined)).toThrow(
    "invalid Agent followed tasks response",
  );
});
