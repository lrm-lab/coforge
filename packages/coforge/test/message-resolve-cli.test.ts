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
