import { expect, test } from "bun:test";
import { parseTaskArgs } from "../src/task-args";

test("task show is the task conversation command", () => {
  expect(parseTaskArgs(["show", "dm:@ada:#7"])).toEqual({
    command: "task-conversation",
    op: "show",
    task: { ref: "dm:@ada:#7", board: "dm:@ada", number: 7 },
  });
});

test("board task commands use --channel, peer kind and JSON output", () => {
  expect(
    parseTaskArgs([
      "history",
      "--channel",
      "dm:@helper",
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
  expect(parseTaskArgs(["convert", "--channel", "#general", "--message-id", "abc12345"])).toEqual({
    command: "task",
    task: { operation: "convert", target: "#general", messageId: "abc12345" },
  });
});
