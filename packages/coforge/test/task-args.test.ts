import { expect, test } from "bun:test";
import { parseTaskArgs } from "../src/task-args";

test("Backlog is a writable status, a create status, and takes an optional --reason on update", () => {
  expect(parseTaskArgs(["list", "--target", "#general", "--status", "backlog"])).toMatchObject({
    task: { status: "backlog" },
  });
  expect(
    parseTaskArgs(["update", "--target", "#general", "--number", "7", "--status", "backlog"]),
  ).toMatchObject({ task: { operation: "update", status: "backlog" } });
  expect(
    parseTaskArgs([
      "update",
      "--target",
      "#general",
      "--number",
      "7",
      "--status",
      "backlog",
      "--reason",
      "  wait for\n  upstream API  ",
    ]),
  ).toMatchObject({
    task: { operation: "update", status: "backlog", reason: "wait for upstream API" },
  });
  expect(() =>
    parseTaskArgs([
      "update",
      "--target",
      "#general",
      "--number",
      "7",
      "--status",
      "done",
      "--reason",
      "why",
    ]),
  ).toThrow("--reason is only for moving a task to backlog");
  expect(
    parseTaskArgs([
      "create",
      "--target",
      "#general",
      "--message-id",
      "abc12345",
      "--title",
      "Later",
      "--status",
      "backlog",
    ]),
  ).toMatchObject({ task: { operation: "create", status: "backlog", priority: "medium" } });
  expect(() =>
    parseTaskArgs([
      "create",
      "--target",
      "#general",
      "--message-id",
      "abc12345",
      "--title",
      "Bad",
      "--status",
      "done",
    ]),
  ).toThrow("--status must be one of: backlog, todo, in_progress; got done");
});

test("task show is the board command", () => {
  expect(parseTaskArgs(["show", "--target", "#general", "--number", "7"])).toEqual({
    command: "task",
    task: { operation: "show", target: "#general", number: 7 },
  });
});

test("board task commands use --target, peer kind and JSON output", () => {
  expect(
    parseTaskArgs([
      "history",
      "--target",
      "@helper",
      "--peer-kind",
      "agent",
      "--number",
      "7",
      "--json",
    ]),
  ).toEqual({
    command: "task",
    json: true,
    task: {
      operation: "history",
      target: "@helper",
      peerKind: "agent",
      number: 7,
    },
  });
});

test("convert requires the source message id and defaults priority to medium", () => {
  expect(
    parseTaskArgs([
      "convert",
      "--target",
      "#general",
      "--message-id",
      "abc12345",
      "--priority",
      "high",
    ]),
  ).toEqual({
    command: "task",
    task: { operation: "convert", target: "#general", messageId: "abc12345", priority: "high" },
  });
  expect(parseTaskArgs(["convert", "--target", "#general", "--message-id", "abc12345"])).toEqual({
    command: "task",
    task: { operation: "convert", target: "#general", messageId: "abc12345", priority: "medium" },
  });
});

test("create and amend take --blocked-by and --parent; list takes --ready", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  expect(
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "medium",
      "--blocked-by",
      "3,5",
      "--parent",
      "7",
    ]),
  ).toMatchObject({ task: { blockedBy: [{ number: 3 }, { number: 5 }], parent: { number: 7 } } });
  expect(
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "low",
      "--blocked-by",
      "3,#coforge:#388",
      "--parent",
      "#ops:#7",
    ]),
  ).toMatchObject({
    task: {
      blockedBy: [{ number: 3 }, { number: 388, channel: "coforge" }],
      parent: { number: 7, channel: "ops" },
    },
  });
  for (const raw of ["#Bad Name:#3", "#coforge/3", "coforge/", "/3", "a/b/3", "coforge/x"])
    expect(() =>
      parseTaskArgs(["create", ...target, ...src, "--title", "A", "--blocked-by", raw]),
    ).toThrow();
  expect(
    parseTaskArgs(["amend", ...target, "--number", "2", "--blocked-by", "", "--parent", ""]),
  ).toMatchObject({ task: { number: 2, blockedBy: [], parent: null } });
  expect(parseTaskArgs(["list", ...target, "--ready"])).toMatchObject({ task: { ready: true } });
  expect(() =>
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--blocked-by", ""]),
  ).toThrow();
  expect(() =>
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--parent", "x"]),
  ).toThrow();
  expect(() =>
    parseTaskArgs(["amend", ...target, "--number", "2", "--blocked-by", "1,x"]),
  ).toThrow();
  expect(() => parseTaskArgs(["list", ...target, "--ready", "--status", "todo"])).toThrow();
});

test("task list --status takes one status, all, or several comma-separated", () => {
  const target = ["--target", "#general"];
  expect(parseTaskArgs(["list", ...target, "--status", "todo"])).toMatchObject({
    task: { status: "todo" },
  });
  const several = parseTaskArgs(["list", ...target, "--status", "in_progress,todo"]);
  expect(several).toMatchObject({ task: { statuses: ["todo", "in_progress"] } });
  expect((several as { task: { status?: unknown } }).task.status).toBeUndefined();
  for (const raw of ["todo,bogus", "all,todo", "todo,", ",todo", "todo,todo"])
    expect(() => parseTaskArgs(["list", ...target, "--status", raw])).toThrow();
});

test("assign folds whitespace in --reason up to 500 chars and accepts a positional assignee", () => {
  const target = ["--target", "#general"];
  const assign = (...extra: string[]) =>
    parseTaskArgs(["assign", ...target, "--number", "7", "--assignee", "@ada", ...extra]);
  expect(assign("--reason", "  finish the\ndaemon side  ")).toMatchObject({
    task: { reason: "finish the daemon side" },
  });
  expect(assign()).not.toHaveProperty("task.reason");
  expect(
    parseTaskArgs(["assign", "#general:#7", "@ada", "--reason", "Take over review"]),
  ).toMatchObject({
    task: {
      operation: "assign",
      target: "#general",
      number: 7,
      assignee: "@ada",
      reason: "Take over review",
    },
  });
  expect(() => assign("--reason", "   ")).toThrow(/must say something/);
  expect(() => assign("--reason", "x".repeat(501))).toThrow(/longer than 500/);
  expect(() =>
    parseTaskArgs(["update", ...target, "--number", "7", "--status", "done", "--reason", "why"]),
  ).toThrow();
});

test("create, claim and assign take --anyway to confirm a held review", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  expect(
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--priority", "high", "--anyway"]),
  ).toMatchObject({
    task: { continueAnyway: true },
  });
  expect(parseTaskArgs(["claim", ...target, "--number", "7", "--anyway"])).toMatchObject({
    task: { continueAnyway: true },
  });
  expect(
    parseTaskArgs(["assign", ...target, "--number", "7", "--assignee", "@ada", "--anyway"]),
  ).toMatchObject({ task: { continueAnyway: true } });
  expect(
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--priority", "medium"]),
  ).not.toHaveProperty("task.continueAnyway");
  expect(() =>
    parseTaskArgs(["update", ...target, "--number", "7", "--status", "done", "--anyway"]),
  ).toThrow();
});

test("task numbers are plain digits: exponent, hex and decimal forms are refused", () => {
  const target = ["--target", "#general"];
  for (const raw of ["1e1", "0x10", "1.0", "+3", "-1"]) {
    expect(() => parseTaskArgs(["show", ...target, "--number", raw])).toThrow();
    expect(() => parseTaskArgs(["create", ...target, "--title", "A", "--parent", raw])).toThrow();
    expect(() =>
      parseTaskArgs(["create", ...target, "--title", "A", "--blocked-by", `2,${raw}`]),
    ).toThrow();
  }
  expect(parseTaskArgs(["show", ...target, "--number", " 12 "])).toMatchObject({
    task: { number: 12 },
  });
});

test("labels: create attaches, amend adds and takes off, list filters", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  expect(
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "low",
      "--label",
      "Design",
      "--label",
      "Bug",
    ]),
  ).toMatchObject({ task: { labels: ["Design", "Bug"] } });
  expect(
    parseTaskArgs(["amend", ...target, "--number", "7", "--label", "Design", "--label", "-Bug"]),
  ).toMatchObject({ task: { labels: ["Design"], removeLabels: ["Bug"] } });
  expect(parseTaskArgs(["list", ...target, "--label", "Design", "--label", "Bug"])).toMatchObject({
    task: { labels: ["Design", "Bug"] },
  });
  expect(() =>
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--label", "-Bug"]),
  ).toThrow();
  expect(() => parseTaskArgs(["amend", ...target, "--number", "7", "--label", "-"])).toThrow();
});

test("--priority sets a new task's priority and an update's, with or without --status", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  expect(
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--priority", "urgent"]),
  ).toMatchObject({ task: { operation: "create", priority: "urgent" } });
  expect(parseTaskArgs(["update", ...target, "--number", "7", "--priority", "low"])).toEqual({
    command: "task",
    task: { operation: "update", target: "#general", number: 7, priority: "low" },
  });
  expect(
    parseTaskArgs([
      "update",
      ...target,
      "--number",
      "7",
      "--status",
      "in_review",
      "--priority",
      "high",
    ]),
  ).toMatchObject({ task: { status: "in_review", priority: "high" } });
  expect(() => parseTaskArgs(["update", ...target, "--number", "7"])).toThrow(
    "--status, --priority or --label",
  );
  expect(() => parseTaskArgs(["update", ...target, "--number", "7", "--priority", "asap"])).toThrow(
    "--priority must be one of: urgent, high, medium, low; got asap",
  );
  expect(() =>
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--priority", "p1"]),
  ).toThrow("--priority must be one of: urgent, high, medium, low; got p1");
  expect(() =>
    parseTaskArgs(["amend", ...target, "--number", "7", "--title", "B", "--priority", "high"]),
  ).toThrow();
});

test("create and convert default --priority to medium, and none is never a choice", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  const levels = "--priority must be one of: urgent, high, medium, low";
  expect(parseTaskArgs(["create", ...target, ...src, "--title", "A"])).toMatchObject({
    task: { operation: "create", priority: "medium" },
  });
  expect(() =>
    parseTaskArgs(["create", ...target, ...src, "--title", "A", "--priority", "none"]),
  ).toThrow(`${levels}; got none`);
  expect(() =>
    parseTaskArgs(["convert", ...target, "--message-id", "abc12345", "--priority", "none"]),
  ).toThrow(`${levels}; got none`);
  expect(() => parseTaskArgs(["update", ...target, "--number", "7", "--priority", "none"])).toThrow(
    `${levels}; got none`,
  );
  for (const operation of ["list", "show", "claim", "amend", "history"])
    expect(() =>
      parseTaskArgs([operation, ...target, "--number", "7", "--priority", "high"]),
    ).toThrow("Usage:");
});

test("--due sets a new task's due instant; a bare date means end of local day with dueHasTime=false", () => {
  const target = ["--target", "#general"];
  const src = ["--message-id", "abc12345"];
  const endOfDay = new Date("2026-11-21T00:00:00").toISOString();
  const localEvening = new Date("2026-11-20T17:30").toISOString();
  expect(
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "high",
      "--due",
      "2026-11-20",
    ]),
  ).toMatchObject({ task: { operation: "create", dueAt: endOfDay, dueHasTime: false } });
  expect(
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "high",
      "--due",
      "2026-11-20T17:30",
    ]),
  ).toMatchObject({ task: { dueAt: localEvening, dueHasTime: true } });
  expect(() =>
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "high",
      "--due",
      "friday",
    ]),
  ).toThrow("--due must be a date or datetime");
  expect(() =>
    parseTaskArgs([
      "create",
      ...target,
      ...src,
      "--title",
      "A",
      "--priority",
      "high",
      "--due",
      " ",
    ]),
  ).toThrow("--due must be a date or datetime");
});

test("amend takes --due or --clear-due as its amendment, never both", () => {
  const target = ["--target", "#general"];
  const endOfDay = new Date("2026-11-21T00:00:00").toISOString();
  const instant = new Date("2026-11-20T09:00:00").toISOString();
  expect(parseTaskArgs(["amend", ...target, "--number", "7", "--due", "2026-11-20"])).toEqual({
    command: "task",
    task: { operation: "amend", target: "#general", number: 7, dueAt: endOfDay, dueHasTime: false },
  });
  expect(
    parseTaskArgs(["amend", ...target, "--number", "7", "--due", "2026-11-20T09:00"]),
  ).toMatchObject({ task: { dueAt: instant, dueHasTime: true } });
  expect(parseTaskArgs(["amend", ...target, "--number", "7", "--clear-due"])).toEqual({
    command: "task",
    task: { operation: "amend", target: "#general", number: 7, dueAt: null },
  });
  expect(() =>
    parseTaskArgs(["amend", ...target, "--number", "7", "--due", "2026-11-20", "--clear-due"]),
  ).toThrow("Use either --due or --clear-due, not both");
  expect(() => parseTaskArgs(["amend", ...target, "--number", "7", "--due", "soonish"])).toThrow(
    "--due must be a date or datetime",
  );
  // A due flag alone is an amendment; other operations refuse it outright.
  for (const operation of ["list", "show", "update", "claim", "convert"])
    expect(() =>
      parseTaskArgs([operation, ...target, "--number", "7", "--due", "2026-11-20"]),
    ).toThrow("Usage:");
});
