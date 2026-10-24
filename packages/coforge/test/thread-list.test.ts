import { expect, test } from "bun:test";
import type { AgentThreadListResponse } from "@lrm/coforge-sdk/agent";
import { parseArgs, run } from "../index";

const transport = (response: AgentThreadListResponse) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  threadList: async () => response,
});

test("thread list takes no arguments", () => {
  expect(parseArgs(["thread", "list"])).toEqual({ command: "thread-list" });
  expect(() => parseArgs(["thread", "list", "--all"])).toThrow("Usage: coforge thread list");
});

test("lists each followed thread with its target, message, parent and follow time", async () => {
  const output = await run(
    ["thread", "list"],
    transport({
      ok: true,
      threads: [
        {
          target: "#general:01a16c6c-1c04",
          parentChannel: "#general",
          rootMessageId: "01a16c6c-1c04-77cc-ac0d-1ec28453613a",
          followedAt: "2026-10-24T17:00:00.000Z",
        },
        {
          target: "#ops:01a16c6c-1d00",
          parentChannel: "#ops",
          rootMessageId: "01a16c6c-1d00-77cc-ac0d-1ec28453613a",
          followedAt: "2026-10-23T09:30:00.000Z",
        },
      ],
    }),
  );
  expect(output).toBe(
    [
      "Followed threads (2):",
      "- #general:01a16c6c-1c04 (message=01a16c6c-1c04-77cc-ac0d-1ec28453613a, parent=#general, followedAt=2026-10-24T17:00:00.000Z)",
      "- #ops:01a16c6c-1d00 (message=01a16c6c-1d00-77cc-ac0d-1ec28453613a, parent=#ops, followedAt=2026-10-23T09:30:00.000Z)",
    ].join("\n"),
  );
});

test("says so when the Agent follows no thread", async () => {
  expect(await run(["thread", "list"], transport({ ok: true, threads: [] }))).toBe(
    "No followed threads.",
  );
});
