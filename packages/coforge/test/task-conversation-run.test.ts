import { expect, test } from "bun:test";
import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import { CliError } from "../src/cli-error";
import { parseTaskConversationArgs } from "../src/task-conversation-args";
import { runTaskConversation } from "../src/task-conversation-run";

const REF = "#general:#7";
const WIRE = { channel: "#general", task_number: "7" };

function invoke(args: string[]) {
  return parseTaskConversationArgs(args)!;
}

function transportAnswering(...answers: Array<unknown | Error>) {
  const requests: AgentTaskConversationRequest[] = [];
  return {
    requests,
    taskConversation: async (request: AgentTaskConversationRequest) => {
      requests.push(request);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const retryable = (code: string) => new CliError({ code, message: "down", retryable: true });

test("view asks for the task and its limit and prints the view", async () => {
  const transport = transportAnswering({
    taskRef: REF,
    task: { id: "t", number: 7, title: "Fix it", status: "todo" },
    following: false,
    followReason: null,
    conversation: { exists: false, replyCount: 0 },
    recentMessages: [],
    hasOlder: false,
  });
  const text = await runTaskConversation(transport, invoke(["view", REF, "--limit", "3"]));
  expect(transport.requests).toEqual([{ route: "view", query: { ...WIRE, limit: "3" } }]);
  expect(text).toContain("## Task #general:#7 [todo]");
});

test("a dm ref is sent as its board", async () => {
  const transport = transportAnswering({
    ok: true,
    taskRef: "dm:@ada:#2",
    following: true,
    changed: true,
  });
  await runTaskConversation(transport, invoke(["follow", "dm:@ada:#2"]));
  expect(transport.requests).toEqual([
    { route: "follow", body: { channel: "dm:@ada", task_number: 2 } },
  ]);
});

test("reply sends the trimmed stdin body under one idempotency key", async () => {
  const transport = transportAnswering({ messageId: "m1", sequence: 4, idempotencyKey: "k" });
  const text = await runTaskConversation(
    transport,
    invoke(["reply", REF]),
    async () => "  hello\n",
  );
  expect(text).toBe("Reply sent to #general:#7. Message ID: m1");
  const [request] = transport.requests;
  expect(request).toMatchObject({
    route: "reply",
    body: { channel: "#general", task_number: 7, content: "hello" },
  });
  expect((request!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test("reply with --json prints the response as JSON", async () => {
  const transport = transportAnswering({ messageId: "m1", sequence: 4 });
  const text = await runTaskConversation(
    transport,
    invoke(["reply", REF, "--json"]),
    async () => "hi",
  );
  expect(JSON.parse(text)).toEqual({ ok: true, data: { messageId: "m1", sequence: 4 } });
});

test("a reply over the server's length is refused before anything is sent", async () => {
  const error = await runTaskConversation(transportAnswering(), invoke(["reply", REF]), async () =>
    "x".repeat(50_001),
  ).catch((failure: CliError) => failure);
  expect((error as CliError).code).toBe("INVALID_ARG");
});

test("reply without a body is refused before anything is sent, with the heredoc to use", async () => {
  const transport = transportAnswering();
  const error = await runTaskConversation(
    transport,
    invoke(["reply", REF]),
    async () => " \n",
  ).catch((failure: CliError) => failure);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("MISSING_CONTENT");
  expect((error as CliError).message).toBe(
    [
      "No reply content received on stdin. Use a heredoc or pipe content into coforge task reply:",
      `  coforge task reply "${REF}" <<'COFORGE_MESSAGE'`,
      "  reply body",
      "  COFORGE_MESSAGE",
    ].join("\n"),
  );
  expect(transport.requests).toEqual([]);
});

test("a reply is retried once, with the same key, after a transport failure or a 5xx", async () => {
  for (const failure of [retryable("REPLY_FAILED"), retryable("SERVER_5XX")]) {
    const transport = transportAnswering(failure, { messageId: "m2", sequence: 5 });
    const text = await runTaskConversation(transport, invoke(["reply", REF]), async () => "hi");
    expect(text).toBe("Reply sent to #general:#7. Message ID: m2");
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toEqual(transport.requests[0]!);
  }
});

test("a reply that fails again, or is refused, is not sent a third time", async () => {
  const twice = transportAnswering(retryable("SERVER_5XX"), retryable("SERVER_5XX"), {
    messageId: "m",
  });
  await expect(
    runTaskConversation(twice, invoke(["reply", REF]), async () => "hi"),
  ).rejects.toThrow("down");
  expect(twice.requests).toHaveLength(2);
  const refused = transportAnswering(new CliError({ code: "NOT_FOUND", message: "not found" }));
  await expect(
    runTaskConversation(refused, invoke(["reply", REF]), async () => "hi"),
  ).rejects.toThrow("not found");
  expect(refused.requests).toHaveLength(1);
});

test("read sends the window and prints it as a task conversation", async () => {
  const transport = transportAnswering({
    messages: [
      {
        id: "01a16c6c-1c04-77cc-ac0d-1ec28453613a",
        sequence: 1,
        body: "hi",
        createdAt: "2026-10-30T10:00:00.000Z",
        senderKind: "agent",
        senderHandle: "ada",
        target: REF,
      },
    ],
    hasOlder: true,
    hasNewer: false,
  });
  const text = await runTaskConversation(
    transport,
    invoke(["read", REF, "--before", "abcd1234", "--limit", "5"]),
  );
  expect(transport.requests).toEqual([
    { route: "read", query: { ...WIRE, before: "abcd1234", limit: "5" } },
  ]);
  expect(text).toContain("Coverage: this task conversation only.");
  expect(text).toContain('Older exist: coforge task read "#general:#7" --before 01a16c6c-1c04.');
  expect(text).not.toContain("replyTarget");
});

test("read --unread sends unread=true and points the next page at task read", async () => {
  const transport = transportAnswering({
    messages: [],
    hasOlder: false,
    hasNewer: false,
    unreadCursorBefore: 3,
    readPositionAfter: 3,
    moreUnread: false,
  });
  const text = await runTaskConversation(transport, invoke(["read", REF, "--unread"]));
  expect(transport.requests).toEqual([{ route: "read", query: { ...WIRE, unread: "true" } }]);
  expect(text).toContain("No unread messages in #general:#7. You have read through seq 3.");
});

test("unfollow sends its reason, and list --following asks for the followed tasks", async () => {
  const transport = transportAnswering(
    { ok: true, taskRef: REF, following: false, changed: true },
    { tasks: [] },
  );
  await runTaskConversation(transport, invoke(["unfollow", REF, "--reason", "handed over"]));
  const listed = await runTaskConversation(transport, invoke(["list", "--following"]));
  expect(transport.requests).toEqual([
    { route: "unfollow", body: { channel: "#general", task_number: 7, reason: "handed over" } },
    { route: "following" },
  ]);
  expect(listed).toBe("You follow no task conversations in your Workspace.");
});

test("an answer of the wrong shape is INVALID_JSON_RESPONSE, and a missing transport is refused", async () => {
  const error = await runTaskConversation(
    transportAnswering({ nope: 1 }),
    invoke(["view", REF]),
  ).catch((failure: CliError) => failure);
  expect((error as CliError).code).toBe("INVALID_JSON_RESPONSE");
  await expect(runTaskConversation({}, invoke(["view", REF]))).rejects.toThrow(
    "Task conversation transport is unavailable",
  );
});

test("a reply with a --mention the body does not name is refused before anything is sent", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const error = await runTaskConversation(
    transportAnswering(),
    invoke(["reply", REF, "--mention", `agent:${id}:kiro`]),
    async () => "hello",
  ).catch((failure: CliError) => failure);
  expect((error as CliError).code).toBe("MENTION_NOT_IN_CONTENT");
});
