import { expect, test } from "bun:test";
import { parseArgs } from "../index";
import { CliError } from "#src/cli-error";

test("Task commands require exact arguments and reject thread targets", () => {
  expect(
    parseArgs(["task", "claim", "--target", "#general", "--message-id", "message-1"]),
  ).toMatchObject({
    command: "task",
    task: { operation: "claim", target: "#general", messageId: "message-1" },
  });
  expect(parseArgs(["task", "list", "--target", "@ada", "--status", "todo"])).toMatchObject({
    command: "task",
    task: { operation: "list", target: "@ada", status: "todo" },
  });
  expect(
    parseArgs([
      "task",
      "create",
      "--target",
      "#general",
      "--title",
      "Ship it",
      "--assignee",
      "@ada",
    ]),
  ).toMatchObject({ task: { operation: "create", title: "Ship it", assignee: "@ada" } });
  expect(refusal(["task", "claim", "--target", "#general"])).toEqual(
    invalidArg("Provide at least one --number or --message-id"),
  );
  expect(refusal(["task", "list", "--target", "#general:deadbeef"])).toEqual(
    invalidArg("--target must be a conversation ('#channel' or '@peer'); got #general:deadbeef"),
  );
  expect(refusal(["task", "delete", "--target", "#general"])).toEqual(
    invalidArg("--number is required"),
  );
});

test("Task create takes repeated titles, an @handle assignee and a resource receipt gate", () => {
  expect(
    parseArgs([
      "task",
      "create",
      "--target",
      "#general",
      "--title",
      "Draft",
      "--title",
      "Review",
      "--assignee",
      " @ada ",
      "--creates-resource",
    ]),
  ).toMatchObject({
    task: {
      operation: "create",
      titles: ["Draft", "Review"],
      assignee: "@ada",
      createsResource: true,
    },
  });
  const single = parseArgs(["task", "create", "--target", "#general", "--title", "One"]) as {
    task: Record<string, unknown>;
  };
  expect(single.task).toMatchObject({ title: "One" });
  expect(single.task).not.toHaveProperty("titles");
  expect(single.task).not.toHaveProperty("createsResource");
  expect(refusal(["task", "create", "--target", "#general"])).toEqual(
    invalidArg("--title is required (at least one)"),
  );
  expect(refusal(["task", "create", "--target", "#general", "--title", "  "])).toEqual(
    invalidArg("--title must be nonblank"),
  );
  expect(
    refusal(["task", "create", "--target", "#general", "--title", "One", "--assignee", "ada"]),
  ).toEqual(invalidArg("--assignee must be an @handle"));
  expect(
    refusal(["task", "create", "--target", "#general", "--title", "One", "--assignee", "@Ada"]),
  ).toEqual(invalidArg("--assignee must be an @handle"));
  expect(refusal(["task", "create", "--title", "One"])).toEqual(invalidArg("--target is required"));
});

test("Task claim takes repeated numbers and message ids together", () => {
  expect(
    parseArgs([
      "task",
      "claim",
      "--target",
      "#general",
      "--number",
      "1",
      "--number",
      "2",
      "--message-id",
      "abcd1234",
    ]),
  ).toMatchObject({
    task: { operation: "claim", numbers: [1, 2], messageId: "abcd1234" },
  });
  expect(
    parseArgs([
      "task",
      "claim",
      "--target",
      "#general",
      "--message-id",
      "abcd1234",
      "--message-id",
      "ef567890",
    ]),
  ).toMatchObject({ task: { messageIds: ["abcd1234", "ef567890"] } });
  expect(refusal(["task", "claim", "--target", "#general", "--number", "0"])).toEqual(
    invalidArg("--number must be a positive integer; got 0"),
  );
  expect(refusal(["task", "claim", "--target", "#general", "--number", "1.5"])).toEqual(
    invalidArg("--number must be a positive integer; got 1.5"),
  );
});

test("Task update, assign, convert, amend and receipt name what is wrong with their arguments", () => {
  const update = ["task", "update", "--target", "#general"];
  expect(refusal([...update, "--status", "done"])).toEqual(
    invalidArg("Provide exactly one --number"),
  );
  expect(refusal([...update, "--number", "1", "--number", "2", "--status", "done"])).toEqual(
    invalidArg(
      "task update accepts exactly one --number; received 2. Run task update once per task.",
    ),
  );
  expect(refusal([...update, "--number", "1", "--status", "open"])).toEqual(
    invalidArg("--status must be one of: todo, in_progress, in_review, done, closed; got open"),
  );
  expect(refusal([...update, "--number", "1"])).toEqual(
    invalidArg("task update needs --status, --priority or --label"),
  );
  expect(
    refusal([...update, "--number", "1", "--status", "done", "--expected-revision", "-1"]),
  ).toEqual(invalidArg("--expected-revision must be a non-negative integer; got -1"));

  const assign = ["task", "assign", "--target", "#general", "--number", "2"];
  expect(parseArgs([...assign, "--assignee", "ada"])).toMatchObject({
    task: { operation: "assign", assignee: "@ada" },
  });
  expect(refusal([...assign, "--assignee", "@Ada Lovelace"])).toEqual(
    invalidArg("--assignee must be an @handle"),
  );
  expect(refusal(assign)).toEqual(
    invalidArg("--assignee <@who> is required; to clear the assignee use `coforge task unassign`"),
  );

  expect(refusal(["task", "convert", "--target", "#general"])).toEqual(
    invalidArg("--message-id is required"),
  );
  expect(refusal(["task", "amend", "--target", "#general", "--number", "2"])).toEqual(
    invalidArg(
      "At least one amendment is required: --title, --description, --clear-description, --blocked-by, --parent, --label, --project, or --clear-project",
    ),
  );
  expect(
    refusal([
      "task",
      "amend",
      "--target",
      "#general",
      "--number",
      "2",
      "--description",
      "x",
      "--clear-description",
    ]),
  ).toEqual(invalidArg("Use either --description or --clear-description, not both"));
  expect(refusal(["task", "history", "--target", "#general", "--number", "x"])).toEqual(
    invalidArg("--number must be a positive integer; got x"),
  );
  // Delete and receipt take no revision: the server would refuse it.
  for (const operation of ["delete", "receipt"])
    expect(() =>
      parseArgs([
        "task",
        operation,
        "--target",
        "#general",
        "--number",
        "2",
        "--expected-revision",
        "1",
      ]),
    ).toThrow("Usage:");
});

test("Task command parsing covers lifecycle actions and explicit description clearing", () => {
  expect(
    parseArgs(["task", "assign", "--target", "#general", "--number", "2", "--assignee", "@ada"]),
  ).toMatchObject({ task: { operation: "assign", number: 2, assignee: "@ada" } });
  expect(
    parseArgs(["task", "amend", "--target", "#general", "--number", "2", "--clear-description"]),
  ).toMatchObject({ task: { operation: "amend", number: 2, description: null } });
  for (const operation of ["history", "delete"] as const)
    expect(parseArgs(["task", operation, "--target", "#general", "--number", "2"])).toMatchObject({
      task: { operation, number: 2 },
    });
});

test("Task unassign dispatches its own protocol operation with no assignee", () => {
  const unassign = parseArgs(["task", "unassign", "--target", "#general", "--number", "2"]) as {
    task: Record<string, unknown>;
  };
  expect(unassign.task).toMatchObject({ operation: "unassign", number: 2 });
  expect(unassign.task).not.toHaveProperty("assignee");
  expect(
    parseArgs([
      "task",
      "unassign",
      "--target",
      "#general",
      "--number",
      "2",
      "--expected-revision",
      "4",
    ]),
  ).toMatchObject({
    task: { operation: "unassign", number: 2, expectedRevision: 4 },
  });
  expect(() =>
    parseArgs(["task", "unassign", "--target", "#general", "--number", "2", "--assignee", "@ada"]),
  ).toThrow("Usage:");
  expect(refusal(["task", "unassign", "--target", "#general"])).toEqual(
    invalidArg("--number is required"),
  );
});

test("Task list takes exactly one of --target or --mine and names the valid statuses", () => {
  expect(parseArgs(["task", "list", "--mine"])).toEqual({
    command: "task",
    task: expect.objectContaining({ operation: "list", mine: true, target: undefined }),
  });
  const invalid = (args: string[]) => {
    try {
      parseArgs(args);
    } catch (error) {
      return error instanceof CliError ? { code: error.code, message: error.message } : error;
    }
    throw new Error("expected the arguments to be refused");
  };
  expect(invalid(["task", "list", "--mine", "--target", "#general"])).toEqual({
    code: "INVALID_ARG",
    message: "--mine cannot be combined with --target",
  });
  expect(invalid(["task", "list"])).toEqual({
    code: "INVALID_ARG",
    message: "--target is required (or pass --mine)",
  });
  expect(invalid(["task", "list", "--mine", "--status", "open"])).toEqual({
    code: "INVALID_ARG",
    message: "--status must be one of all|todo|in_progress|in_review|done|closed; got open",
  });
  expect(() => parseArgs(["task", "list", "--mine", "--mine"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "claim", "--mine", "--number", "1"])).toThrow("Usage:");
});

/** The typed refusal `parseArgs` throws for the given arguments. */
function refusal(args: string[]) {
  try {
    parseArgs(args);
  } catch (error) {
    return error instanceof CliError ? { code: error.code, message: error.message } : error;
  }
  throw new Error("expected the arguments to be refused");
}

const invalidArg = (message: string) => ({ code: "INVALID_ARG", message });

test("task update takes labels, and task list takes the none filter", () => {
  expect(
    parseArgs(["task", "update", "--target", "#general", "--number", "5", "--label", "Bug"]),
  ).toMatchObject({
    command: "task",
    task: { operation: "amend", number: 5, labels: ["Bug"] },
  });
  expect(
    parseArgs(["task", "update", "--target", "#general", "--number", "5", "--label", "-Bug"]),
  ).toMatchObject({ command: "task", task: { removeLabels: ["Bug"] } });
  expect(parseArgs(["task", "list", "--target", "#general", "--label", "none"])).toMatchObject({
    command: "task",
    task: { operation: "list", labels: ["none"] },
  });
});
