import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { run } from "../index";
import { formatMessageCheck } from "#src/message-check-format";
import { formatReadWindow } from "#src/message-read-format";

function message(target: string): AgentMessageRecord {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    sequence: 7,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target,
    body: "hello",
    createdAt: "2026-09-07T10:00:00Z",
    attachments: [],
  };
}

const summary = (target: string) => ({
  target,
  pendingCount: 1,
  firstPendingSequence: 1,
  latestSequence: 1,
  flags: [],
});

test("a check with nothing says there is no more inbox", () => {
  expect(formatMessageCheck({ messages: [] })).toBe("No more new inbox messages.");
});

test("a check that stopped early says to run it again", () => {
  expect(
    formatMessageCheck({ messages: [message("@ada")], hasMore: true })
      .split("\n")
      .at(-1),
  ).toBe("More messages are pending. Run `coforge message check` again.");
});

test("an empty check names the App Inbox items waiting", () => {
  expect(formatMessageCheck({ messages: [], appItemsPending: 2 }).split("\n")).toEqual([
    "No more new inbox messages.",
    "App items pending: 2. Run `coforge inbox check` to inspect them.",
  ]);
});

test("a check counts the conversations still unread beyond the ones it showed", () => {
  const output = formatMessageCheck({
    messages: [message("@ada")],
    summaries: [summary("@ada"), summary("#general"), summary("#general:abc")],
  });
  expect(output.split("\n").at(-1)).toBe(
    "Still unread: 2 conversations. Run `coforge inbox check` to list them.",
  );
  expect(
    formatMessageCheck({ messages: [], summaries: [summary("#general")] })
      .split("\n")
      .at(-1),
  ).toBe("Still unread: 1 conversation. Run `coforge inbox check` to list them.");
  expect(
    formatMessageCheck({ messages: [message("@ada")], summaries: [summary("@ada")] }),
  ).not.toContain("Still unread");
});

test("a plain read prints no cursor line, only an advanced read position", () => {
  const output = formatReadWindow("#general", {
    messages: [message("#general")],
    unreadCursorBefore: 5,
  });
  expect(output).not.toContain("unread cursor");
  expect(output).toContain("Read window: 1 returned, seq 7, oldest to newest.");
  expect(formatReadWindow("#general", { messages: [message("#general")] })).not.toContain(
    "unread cursor",
  );
});

test("message check says plainly when there are no pending messages", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({ accepted: true, messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe("No more new inbox messages.");
});
