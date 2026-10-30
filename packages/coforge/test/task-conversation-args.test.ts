import { expect, test } from "bun:test";
import { CliError } from "../src/cli-error";
import { parseTaskConversationArgs } from "../src/task-conversation-args";

const GENERAL_7 = { ref: "#general:#7", board: "#general", number: 7 };

function refusal(args: string[]): CliError {
  try {
    parseTaskConversationArgs(args);
  } catch (error) {
    return error as CliError;
  }
  throw new Error("expected a refusal");
}

test("task view takes a ref or --target and --number, and a limit", () => {
  expect(parseTaskConversationArgs(["view", "#general:#7"])).toEqual({
    command: "task-conversation",
    op: "view",
    task: GENERAL_7,
  });
  expect(
    parseTaskConversationArgs(["view", "--limit", "3", "--target", "#general", "--number", "7"]),
  ).toEqual({ command: "task-conversation", op: "view", task: GENERAL_7, limit: 3 });
});

test("task view refuses a limit that is not a positive integer", () => {
  for (const limit of ["0", "-1", "x", "1.5"]) {
    const error = refusal(["view", "#general:#7", "--limit", limit]);
    expect(error.code).toBe("INVALID_ARG");
    expect(error.message).toBe(`--limit must be a positive integer; got ${limit}`);
  }
});

test("task view and unfollow refuse what the server would, naming the limit", () => {
  expect(refusal(["view", "#general:#7", "--limit", "21"]).message).toBe(
    "--limit is at most 20; got 21",
  );
  expect(refusal(["unfollow", "#general:#7", "--reason", "x".repeat(201)]).message).toBe(
    "--reason is at most 200 characters; got 201",
  );
});

test("task reply takes a ref and --json, and nothing the server would drop", () => {
  expect(parseTaskConversationArgs(["reply", "#general:#7", "--json"])).toEqual({
    command: "task-conversation",
    op: "reply",
    task: GENERAL_7,
    json: true,
  });
  expect(refusal(["reply", "#general:#7", "--attachment-id", "a"]).message).toBe(
    'Unknown argument "--attachment-id".',
  );
  expect(refusal(["reply", "#general:#7", "--mention", "x"]).code).toBe("INVALID_ARG");
});

test("task read takes the message read window", () => {
  expect(parseTaskConversationArgs(["read", "#general:#7"])).toEqual({
    command: "task-conversation",
    op: "read",
    task: GENERAL_7,
    options: {},
  });
  expect(
    parseTaskConversationArgs(["read", "dm:@ada:#2", "--before", "abcd1234", "--limit", "5"]),
  ).toEqual({
    command: "task-conversation",
    op: "read",
    task: { ref: "dm:@ada:#2", board: "dm:@ada", number: 2 },
    options: { before: "abcd1234", limit: 5 },
  });
  expect(parseTaskConversationArgs(["read", "#general:#7", "--unread"])).toMatchObject({
    options: { unread: true },
  });
});

test("task read refuses the windows message read refuses, naming the task command", () => {
  expect(refusal(["read", "#general:#7", "--unread", "--after", "5"]).message).toContain(
    "--unread reads forward from your read position",
  );
  expect(refusal(["read", "#general:#7", "--before", "1", "--after", "2"]).message).toBe(
    "Give at most one of --before, --after and --around.",
  );
  const error = refusal(["read", "#general:#7", "--limit", "101"]);
  expect(error.message).toContain("--limit must be a whole number from 1 to 100");
  expect(error.suggestedNextAction).toContain("coforge task read --help");
});

test("task follow and unfollow take a ref, and unfollow a trimmed reason", () => {
  expect(parseTaskConversationArgs(["follow", "#general:#7"])).toEqual({
    command: "task-conversation",
    op: "follow",
    task: GENERAL_7,
  });
  expect(parseTaskConversationArgs(["unfollow", "#general:#7", "--reason", "  done  "])).toEqual({
    command: "task-conversation",
    op: "unfollow",
    task: GENERAL_7,
    reason: "done",
  });
  expect(parseTaskConversationArgs(["unfollow", "#general:#7", "--reason", "  "])).toEqual({
    command: "task-conversation",
    op: "unfollow",
    task: GENERAL_7,
  });
});

test("a command that names no task, or two, or repeats a flag, is refused", () => {
  expect(refusal(["follow"]).code).toBe("INVALID_ARG");
  expect(refusal(["follow", "#general:#7", "#general:#8"]).message).toBe(
    "Give one task ref, not several.",
  );
  expect(refusal(["view", "#general:#7", "--limit", "1", "--limit", "2"]).message).toBe(
    '"--limit" is given more than once.',
  );
  expect(refusal(["view", "#general:#7", "--limit"]).message).toBe('"--limit" needs a value.');
  expect(refusal(["view", "#general:abcd1234"]).code).toBe("INVALID_TARGET");
});

test("task list --following lists the followed conversations and nothing else", () => {
  expect(parseTaskConversationArgs(["list", "--following"])).toEqual({
    command: "task-conversation",
    op: "following",
  });
  for (const extra of [
    ["--mine"],
    ["--target", "#general"],
    ["--channel", "#general"],
    ["--status", "todo"],
  ]) {
    const error = refusal(["list", "--following", ...extra]);
    expect(error.code).toBe("INVALID_ARG");
    expect(error.message).toBe(
      "--following lists the task conversations you follow; it cannot be combined with --mine, --target, --channel or --status",
    );
  }
  expect(refusal(["list", "--following", "--json"]).code).toBe("INVALID_ARG");
});

test("other task operations are not conversation commands", () => {
  expect(parseTaskConversationArgs(["list", "--mine"])).toBeUndefined();
  expect(parseTaskConversationArgs(["create", "--target", "#general"])).toBeUndefined();
  expect(parseTaskConversationArgs([])).toBeUndefined();
});
