import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

test("inbox check accepts text and JSON output modes", () => {
  expect(parseArgs(["inbox", "check"])).toEqual({ command: "inbox-check" });
  expect(parseArgs(["inbox", "check", "--json"])).toEqual({ command: "inbox-check", json: true });
  expect(() => parseArgs(["inbox", "ack", "--item", "reminder:id:1"])).toThrow("Usage:");
});

test("dispatches Inbox check without message operations", async () => {
  const calls: string[] = [];
  const transport = {
    check: async () => {
      throw new Error("message check called");
    },
    read: async () => {
      throw new Error("message read called");
    },
    send: async () => {
      throw new Error("message send called");
    },
    view: async () => {
      throw new Error("attachment called");
    },
    inboxCheck: async () => calls.push("check"),
  };
  await run(["inbox", "check"], transport);
  expect(calls).toEqual(["check"]);
});

test("inbox JSON mode hides message ordering fields", async () => {
  const output = await run(["inbox", "check", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    inboxCheck: async () => ({
      entries: [
        {
          kind: "message_target",
          messageTarget: {
            target: "@ada",
            pendingCount: 2,
            firstPendingSequence: 7,
            latestSequence: 8,
            flags: ["dm"],
          },
        },
      ],
    }),
  });
  expect(output).not.toContain("firstPendingSequence");
  expect(output).not.toContain("latestSequence");
  expect(output).toContain('"pendingCount":2');
});
