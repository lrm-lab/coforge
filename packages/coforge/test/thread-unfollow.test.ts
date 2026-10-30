import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";

const transport = (calls: unknown[] = []) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  setThreadFollowed: async (target: string, followed: boolean) => {
    calls.push([target, followed]);
    return { accepted: true };
  },
});

test("parses the thread and an optional reason in either order", () => {
  expect(parseArgs(["thread", "unfollow", "--target", "#general:12345678"])).toEqual({
    command: "thread-unfollow",
    target: "#general:12345678",
  });
  expect(() =>
    parseArgs(["thread", "unfollow", "--reason", "done here", "--target", "#general:12345678"]),
  ).toThrow("Usage: coforge thread unfollow --target <thread>");
});

test("anything but a channel thread is INVALID_TARGET, and a malformed command gets the usage", () => {
  for (const target of ["#general", "@alice:12345678", "#general:abcdef123"]) {
    try {
      parseArgs(["thread", "unfollow", "--target", target]);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as CliError).code).toBe("INVALID_TARGET");
    }
  }
  expect(() => parseArgs(["thread", "unfollow"])).toThrow("Usage: coforge thread unfollow");
  expect(() => parseArgs(["thread", "unfollow", "--target"])).toThrow("Usage:");
  expect(() =>
    parseArgs(["thread", "unfollow", "--target", "#a:12345678", "--bogus", "x"]),
  ).toThrow("Usage:");
});

test("unfollowing prints what stopped, the reason, and what follows the thread again", async () => {
  const calls: unknown[] = [];
  const output = await run(
    ["thread", "unfollow", "--target", "#general:12345678"],
    transport(calls),
  );
  expect(calls).toEqual([["#general:12345678", false]]);
  expect(output).toBe(
    [
      "Unfollowed #general:12345678. Ordinary delivery for this thread has stopped.",
      'A later reply that mentions you follows the thread again; unfollow it again with: coforge thread unfollow --target "#general:12345678"',
      "Replying in this thread follows it again automatically.",
    ].join("\n"),
  );
  expect(
    await run(["thread", "unfollow", "--target", "#general:12345678"], transport()),
  ).not.toContain("Reason:");
});
