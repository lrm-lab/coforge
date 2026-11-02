import { expect, test } from "bun:test";
import { parseTaskArgs } from "../src/task-args";

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

test("convert requires the source message id", () => {
  expect(parseTaskArgs(["convert", "--target", "#general", "--message-id", "abc12345"])).toEqual({
    command: "task",
    task: { operation: "convert", target: "#general", messageId: "abc12345" },
  });
});

test("create and amend take --blocked-by and --parent; list takes --ready", () => {
  const target = ["--target", "#general"];
  expect(
    parseTaskArgs(["create", ...target, "--title", "A", "--blocked-by", "3,5", "--parent", "7"]),
  ).toMatchObject({ task: { blockedBy: [{ number: 3 }, { number: 5 }], parent: { number: 7 } } });
  expect(
    parseTaskArgs([
      "create",
      ...target,
      "--title",
      "A",
      "--blocked-by",
      "3,#coforge/388",
      "--parent",
      "ops/7",
    ]),
  ).toMatchObject({
    task: {
      blockedBy: [{ number: 3 }, { number: 388, channel: "coforge" }],
      parent: { number: 7, channel: "ops" },
    },
  });
  for (const raw of ["#Bad Name/3", "coforge/", "/3", "a/b/3", "coforge/x"])
    expect(() =>
      parseTaskArgs(["create", ...target, "--title", "A", "--blocked-by", raw]),
    ).toThrow();
  expect(
    parseTaskArgs(["amend", ...target, "--number", "2", "--blocked-by", "", "--parent", ""]),
  ).toMatchObject({ task: { number: 2, blockedBy: [], parent: null } });
  expect(parseTaskArgs(["list", ...target, "--ready"])).toMatchObject({ task: { ready: true } });
  expect(() => parseTaskArgs(["create", ...target, "--title", "A", "--blocked-by", ""])).toThrow();
  expect(() => parseTaskArgs(["create", ...target, "--title", "A", "--parent", "x"])).toThrow();
  expect(() =>
    parseTaskArgs(["amend", ...target, "--number", "2", "--blocked-by", "1,x"]),
  ).toThrow();
  expect(() => parseTaskArgs(["list", ...target, "--ready", "--status", "todo"])).toThrow();
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
