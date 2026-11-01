import { expect, test } from "bun:test";
import { parseArgs, run, type MessageTransport } from "../index";

const create = ["task", "create", "--target", "#general", "--title", "Fix it"];

test("task create takes a description, a source message and --alongside", () => {
  expect(
    parseArgs([
      ...create,
      "--description",
      "Why",
      "--message-id",
      " 01a16c6c-1c04 ",
      "--alongside",
    ]),
  ).toEqual({
    command: "task",
    task: {
      operation: "create",
      target: "#general",
      title: "Fix it",
      description: "Why",
      messageId: "01a16c6c-1c04",
      alongside: true,
    },
  });
});

test("task create without them is as before", () => {
  expect(parseArgs(create)).toEqual({
    command: "task",
    task: { operation: "create", target: "#general", title: "Fix it" },
  });
});

test("one source message may serve every --title, a description only a single one", () => {
  const titles = ["task", "create", "--target", "#general", "--title", "A", "--title", "B"];
  expect(parseArgs([...titles, "--message-id", "m1"])).toMatchObject({
    task: { titles: ["A", "B"], messageId: "m1" },
  });
  expect(() => parseArgs([...titles, "--description", "Why"])).toThrow(
    "--description can only be used with a single --title",
  );
});

test("a blank description or message id is refused", () => {
  expect(() => parseArgs([...create, "--description", "  "])).toThrow(
    "--description must not be empty",
  );
  expect(() => parseArgs([...create, "--message-id", " "])).toThrow(
    "--message-id must not be empty",
  );
});

test("the other task operations do not take them", () => {
  expect(() => parseArgs(["task", "list", "--target", "#general", "--alongside"])).toThrow();
  expect(() =>
    parseArgs(["task", "claim", "--target", "#general", "--number", "1", "--description", "x"]),
  ).toThrow();
});

test("task conversation commands are parsed by coforge's own argument parser", () => {
  expect(parseArgs(["task", "view", "#general:#7", "--limit", "2"])).toEqual({
    command: "task-conversation",
    op: "view",
    task: { ref: "#general:#7", board: "#general", number: 7 },
    limit: 2,
  });
  expect(parseArgs(["task", "list", "--following"])).toEqual({
    command: "task-conversation",
    op: "following",
  });
  expect(parseArgs(["task", "list", "--mine"])).toMatchObject({ command: "task" });
});

test("run sends a task conversation command through the transport", async () => {
  const requests: unknown[] = [];
  const transport = {
    taskConversation: async (request: unknown) => {
      requests.push(request);
      return { ok: true, taskRef: "#general:#7", following: true, changed: true };
    },
  } as unknown as MessageTransport;
  expect(await run(["task", "follow", "#general:#7"], transport)).toBe(
    'Following #general:#7: its replies now wake you.\nTo stop: coforge task unfollow "#general:#7"',
  );
  expect(requests).toEqual([{ route: "follow", body: { channel: "#general", task_number: 7 } }]);
});

test("the task conversation commands and create's new flags are in the help", async () => {
  const { commandHelp } = await import("../src/command-help");
  for (const command of ["view", "reply", "read", "follow", "unfollow"])
    expect(commandHelp(["task", command, "--help"])).toContain(`coforge task ${command} [<ref>]`);
  expect(commandHelp(["task", "create", "--help"])).toContain("--alongside");
  expect(commandHelp(["task", "list", "--help"])).toContain("--following");
});
