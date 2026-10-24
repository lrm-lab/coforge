import { expect, test } from "bun:test";
import { parseArgs, run, type MessageTransport } from "../index";

test("message read --unread reads from the read position and takes no history anchor", () => {
  expect(parseArgs(["message", "read", "--target", "@ada", "--unread"])).toEqual({
    command: "read",
    target: "@ada",
    unread: true,
  });
  expect(parseArgs(["message", "read", "--target", "@ada", "--limit", "5", "--unread"])).toEqual({
    command: "read",
    target: "@ada",
    limit: 5,
    unread: true,
  });
  for (const anchor of ["--before", "--after", "--around"])
    expect(() =>
      parseArgs(["message", "read", "--target", "@ada", "--unread", anchor, "abcd1234"]),
    ).toThrow("Usage:");
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--unread", "--unread"])).toThrow(
    "Usage:",
  );
});

test("message read without --unread keeps its one-anchor window", () => {
  expect(parseArgs(["message", "read", "--target", "@ada", "--around", "abcd1234"])).toEqual({
    command: "read",
    target: "@ada",
    around: "abcd1234",
  });
  expect(() =>
    parseArgs(["message", "read", "--target", "@ada", "--before", "a", "--after", "b"]),
  ).toThrow("Usage:");
});

test("message read --unread asks the transport for unread and prints the unread window", async () => {
  const calls: unknown[] = [];
  const transport = {
    read: async (target: string, options: unknown) => {
      calls.push([target, options]);
      return { messages: [], unreadCursorBefore: 4, readPositionAfter: 4 };
    },
  } as unknown as MessageTransport;
  const output = await run(["message", "read", "--target", "@ada", "--unread"], transport);
  expect(calls).toEqual([["@ada", { command: "read", target: "@ada", unread: true }]]);
  expect(output).toEndWith("No unread messages in @ada. You have read through seq 4.");
});
