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
