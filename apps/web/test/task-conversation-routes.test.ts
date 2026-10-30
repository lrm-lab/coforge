import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  handleTaskFollowingGet,
  handleTaskReadGet,
  handleTaskFollowPost,
  handleTaskReplyPost,
  handleTaskUnfollowPost,
  handleTaskViewGet,
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
const on = async () => true;
const post = (body: unknown) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

test("view reads the task named by channel and number", async () => {
  const response = await handleTaskViewGet(
    new Request("http://x/?channel=%23c&task_number=7&limit=3"),
    principal,
    service as never,
    on,
  );
  expect(await response.json()).toEqual({ taskRef: "#c:#7" });
  expect(calls.at(-1)).toEqual(["view", principal, { target: "#c", number: 7 }, { limit: 3 }]);
});

test("a task number that is not a positive integer is a 400", async () => {
  const response = await handleTaskViewGet(
    new Request("http://x/?channel=%23c&task_number=abc"),
    principal,
    service as never,
    on,
  );
  expect(response.status).toBe(400);
});

test("a limit outside 1 to 20, or not a number, is a 400", async () => {
  for (const limit of ["abc", "0", "21", "2.5"]) {
    const response = await handleTaskViewGet(
      new Request(`http://x/?channel=%23c&task_number=7&limit=${limit}`),
      principal,
      service as never,
      on,
    );
    expect(response.status).toBe(400);
  }
});

test("a direct board is named dm:@peer and resolved as @peer", async () => {
  await handleTaskViewGet(
    new Request("http://x/?channel=dm%3A%40ada&task_number=2"),
    principal,
    service as never,
    on,
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
    on,
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
        on,
      )
    ).status,
  ).toBe(400);
});

test("follow and unfollow answer ok with what changed; an unfollow reason is bounded", async () => {
  const followed = await handleTaskFollowPost(
    post({ channel: "#c", task_number: 7 }),
    principal,
    service as never,
    on,
  );
  expect(await followed.json()).toEqual({ ok: true, following: true, changed: true });
  await handleTaskUnfollowPost(
    post({ channel: "#c", task_number: 7, reason: "handed over" }),
    principal,
    service as never,
    on,
  );
  expect(calls.at(-1)).toEqual(["unfollow", principal, { target: "#c", number: 7 }, "handed over"]);
  const tooLong = await handleTaskUnfollowPost(
    post({ channel: "#c", task_number: 7, reason: "x".repeat(201) }),
    principal,
    service as never,
    on,
  );
  expect(tooLong.status).toBe(400);
});

test("a refusal keeps its status", async () => {
  const refusing = {
    ...service,
    follow: async () => {
      throw new AppError("NOT_FOUND");
    },
  };
  const response = await handleTaskFollowPost(
    post({ channel: "#c", task_number: 7 }),
    principal,
    refusing as never,
    on,
  );
  expect(response.status).toBe(404);
});

test("with the experiment off every route answers 404 and names the setting", async () => {
  const off = async () => false;
  const attempts = [
    handleTaskViewGet(
      new Request("http://x/?channel=%23c&task_number=7"),
      principal,
      service as never,
      off,
    ),
    handleTaskReplyPost(
      post({ channel: "#c", task_number: 7, content: "x", idempotencyKey: "k" }),
      principal,
      service as never,
      off,
    ),
    handleTaskFollowPost(post({ channel: "#c", task_number: 7 }), principal, service as never, off),
    handleTaskUnfollowPost(
      post({ channel: "#c", task_number: 7 }),
      principal,
      service as never,
      off,
    ),
    handleTaskFollowingGet(principal, service as never, off),
  ];
  const before = calls.length;
  for (const response of await Promise.all(attempts)) {
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("task_conversations_off");
    expect(body.error).toContain("Settings → Experiments");
  }
  expect(calls.length).toBe(before);
});

test("read passes the page window and the unread flag, and bounds the limit", async () => {
  const response = await handleTaskReadGet(
    new Request("http://x/?channel=%23c&task_number=7&unread=true&limit=10&before=abc12345"),
    principal,
    service as never,
    on,
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
    on,
  );
  expect(tooMany.status).toBe(400);
});

test("every route acts as the Agent alone: the owner the API key carries is not passed on", async () => {
  // What the Agent API authenticates is the Agent and, beside it, the user who owns it; the task
  // board refuses a principal that names both, so only the Agent may reach it.
  const authenticated = { workspaceId: "w", agentId: "a", userId: "owner" };
  calls.length = 0;
  const ref = "channel=%23c&task_number=7";
  await handleTaskViewGet(new Request(`http://x/?${ref}`), authenticated, service as never, on);
  await handleTaskReadGet(new Request(`http://x/?${ref}`), authenticated, service as never, on);
  await handleTaskFollowingGet(authenticated, service as never, on);
  const body = { channel: "#c", task_number: 7 };
  await handleTaskReplyPost(
    post({ ...body, content: "hi", idempotencyKey: "k" }),
    authenticated,
    service as never,
    on,
  );
  await handleTaskFollowPost(post(body), authenticated, service as never, on);
  await handleTaskUnfollowPost(post(body), authenticated, service as never, on);
  expect(calls.map((call) => call[1])).toEqual(Array(6).fill({ workspaceId: "w", agentId: "a" }));
});
