import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { run } from "../index";

/** A plain-channel message long enough for `check` to summarize it. */
function longChannelMessage(): AgentMessageRecord {
  const body = `${"频道闲聊。".repeat(80)}结尾`;
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    target: "#general",
    body,
    createdAt: "2026-09-07T10:00:00Z",
    senderKind: "human",
    senderName: "Ada",
    senderHandle: "ada",
  } as unknown as AgentMessageRecord;
}

test("message resolve prints the whole body of a long plain-channel message", async () => {
  const message = longChannelMessage();
  const output = await run(["message", "resolve", "bbbbbbbb"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({}),
    view: async () => undefined,
    resolve: async () => ({ messages: [message] }),
  } as never);
  // `check` summarizes this message; resolve names it by id, so cutting it would answer nothing.
  expect(output).toContain("结尾");
  expect(output).not.toContain("…(+");
});

test("resolve answers a miss with NOT_FOUND and where to look next", async () => {
  const transport = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({}),
    view: async () => undefined,
    resolve: async () => ({ messages: [] }),
  } as never;
  await expect(run(["message", "resolve", "bbbbbbbb"], transport)).rejects.toMatchObject({
    code: "NOT_FOUND",
    suggestedNextAction: expect.stringContaining("coforge message search"),
  });
});

test("resolve names an ambiguous prefix instead of guessing", async () => {
  const transport = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({}),
    view: async () => undefined,
    resolve: async () => {
      throw new Error("ambiguous message prefix; use the full UUID");
    },
  } as never;
  await expect(run(["message", "resolve", "bbbbbbbb"], transport)).rejects.toMatchObject({
    code: "AMBIGUOUS_ID",
  });
});

test("message resolve reports a clear error when the message is not found", async () => {
  await expect(
    run(["message", "resolve", "abcd1234"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      resolve: async () => ({ messages: [] }),
    }),
  ).rejects.toThrow('No message this Agent can see matches "abcd1234".');
});
