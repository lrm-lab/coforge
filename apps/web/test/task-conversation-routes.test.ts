import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  handleTaskFollowingGet,
  handleTaskReadGet,
  handleTaskFollowPost,
  handleTaskReplyPost,
  handleTaskUnfollowPost,
  handleTaskViewGet,
  handleTaskIdleNudgePost,
} from "#src/server/tasks/task-conversation-routes.server";

const principal = { workspaceId: "w", agentId: "a" };
const calls: unknown[][] = [];
const record =
  (name: string, result: unknown = {}) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return result;
  };
const service = {
  view: record("view", { taskRef: "#c:#7" }),
  read: record("read", { messages: [] }),
  reply: record("reply", { messageId: "m" }),
  follow: record("follow", { following: true, changed: true }),
  unfollow: record("unfollow", { following: false, changed: true }),
  following: record("following", []),
};
const post = (body: unknown) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

test("view reads the task named by channel and number", async () => {
  const response = await handleTaskViewGet(
    new Request("http://x/?channel=%23c&task_number=7&limit=3"),
    principal,
    service as never,
  );
  expect(await response.json()).toEqual({ taskRef: "#c:#7" });
  expect(calls.at(-1)).toEqual(["view", principal, { target: "#c", number: 7 }, { limit: 3 }]);
});

test("a task number that is not a positive integer is a 400", async () => {
  const response = await handleTaskViewGet(
    new Request("http://x/?channel=%23c&task_number=abc"),
    principal,
    service as never,
  );
  expect(response.status).toBe(400);
});

test("a limit outside 1 to 20, or not a number, is a 400", async () => {
  for (const limit of ["abc", "0", "21", "2.5"]) {
    const response = await handleTaskViewGet(
      new Request(`http://x/?channel=%23c&task_number=7&limit=${limit}`),
      principal,
      service as never,
    );
    expect(response.status).toBe(400);
  }
});

test("a direct board is named dm:@peer and resolved as @peer", async () => {
  await handleTaskViewGet(
    new Request("http://x/?channel=dm%3A%40ada&task_number=2"),
    principal,
    service as never,
  );
  expect(calls.at(-1)).toEqual([
    "view",
    principal,
    { target: "@ada", number: 2 },
    { limit: undefined },
  ]);
});

test("reply carries the body and echoes the idempotency key", async () => {
  const response = await handleTaskReplyPost(
    post({ channel: "#c", task_number: 7, content: "hello", idempotencyKey: "k" }),
    principal,
    service as never,
  );
  expect(await response.json()).toEqual({ messageId: "m", idempotencyKey: "k" });
  expect(calls.at(-1)).toEqual([
    "reply",
    principal,
    { target: "#c", number: 7 },
    { body: "hello", idempotencyKey: "k" },
  ]);
  expect(
    (
      await handleTaskReplyPost(
        post({ channel: "#c", task_number: 7 }),
        principal,
        service as never,
      )
    ).status,
  ).toBe(400);
});

test("follow and unfollow answer ok with what changed; an unfollow reason is bounded", async () => {
  const followed = await handleTaskFollowPost(
    post({ channel: "#c", task_number: 7 }),
    principal,
    service as never,
  );
  expect(await followed.json()).toEqual({ ok: true, following: true, changed: true });
  await handleTaskUnfollowPost(
    post({ channel: "#c", task_number: 7, reason: "handed over" }),
    principal,
    service as never,
  );
  expect(calls.at(-1)).toEqual(["unfollow", principal, { target: "#c", number: 7 }, "handed over"]);
  const tooLong = await handleTaskUnfollowPost(
    post({ channel: "#c", task_number: 7, reason: "x".repeat(201) }),
    principal,
    service as never,
  );
  expect(tooLong.status).toBe(400);
});

test("a refusal keeps its status and in-progress reconcile returns 409 retryable", async () => {
  const { MessageRequestInProgressError } =
    await import("#src/server/conversations/message-request-idempotency.server");
  const refusing = {
    ...service,
    follow: async () => {
      throw new AppError("NOT_FOUND");
    },
    reconcileReply: async () => {
      throw new MessageRequestInProgressError();
    },
  };
  const response = await handleTaskFollowPost(
    post({ channel: "#c", task_number: 7 }),
    principal,
    refusing as never,
  );
  expect(response.status).toBe(404);
  const inProgress = await handleTaskReplyPost(
    post({ channel: "#c", task_number: 7, idempotencyKey: "k-busy", reconcileOnly: true }),
    principal,
    refusing as never,
  );
  expect(inProgress.status).toBe(409);
  expect(await inProgress.json()).toMatchObject({
    code: "MESSAGE_REQUEST_IN_PROGRESS",
    retryable: true,
  });
});

test("following lists the tasks the Agent follows", async () => {
  const response = await handleTaskFollowingGet(principal, service as never);
  expect(await response.json()).toEqual({ tasks: [] });
  expect(calls.at(-1)).toEqual(["following", principal]);
});

test("read passes the page window and the unread flag, and bounds the limit", async () => {
  const response = await handleTaskReadGet(
    new Request("http://x/?channel=%23c&task_number=7&unread=true&limit=10&before=abc12345"),
    principal,
    service as never,
  );
  expect(await response.json()).toEqual({ messages: [] });
  expect(calls.at(-1)).toEqual([
    "read",
    principal,
    { target: "#c", number: 7 },
    { before: "abc12345", limit: 10, unread: true },
  ]);
  const tooMany = await handleTaskReadGet(
    new Request("http://x/?channel=%23c&task_number=7&limit=101"),
    principal,
    service as never,
  );
  expect(tooMany.status).toBe(400);
});

test("idle-nudge passes the request on; an empty body is no options, a bad one is 400", async () => {
  const asked: unknown[] = [];
  const nudge = async (input: unknown) => {
    asked.push(input);
    return { send: false, reason: "no_change" as const, items: [], backlog: [], text: "" };
  };
  const empty = new Request("http://x/", { method: "POST" });
  expect(await (await handleTaskIdleNudgePost(empty, nudge)).json()).toMatchObject({
    send: false,
    reason: "no_change",
  });
  await handleTaskIdleNudgePost(
    post({ freshSession: true, backgroundTasks: 2, rulesShown: true }),
    nudge,
  );
  expect(asked).toEqual([{}, { freshSession: true, backgroundTasks: 2, rulesShown: true }]);
  for (const body of [{ backgroundTasks: 10_001 }, { backgroundTasks: -1 }, { fresh: true }])
    expect((await handleTaskIdleNudgePost(post(body), nudge)).status).toBe(400);
  expect(asked).toHaveLength(2);
});

test("reply with reconcileOnly probes reconcileReply and requires idempotencyKey", async () => {
  const reconciler = {
    ...service,
    reconcileReply: record("reconcileReply", {
      state: "committed",
      messageId: "m-reconciled",
      sequence: 9,
      idempotencyKey: "k-1",
    }),
  };
  const ok = await handleTaskReplyPost(
    post({ channel: "#c", task_number: 7, idempotencyKey: "k-1", reconcileOnly: true }),
    principal,
    reconciler as never,
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({
    state: "committed",
    messageId: "m-reconciled",
    sequence: 9,
    idempotencyKey: "k-1",
  });
  expect(calls.at(-1)).toEqual(["reconcileReply", principal, { target: "#c", number: 7 }, "k-1"]);

  const missingKey = await handleTaskReplyPost(
    post({ channel: "#c", task_number: 7, reconcileOnly: true }),
    principal,
    reconciler as never,
  );
  expect(missingKey.status).toBe(400);
});
