import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { formatMessageLine } from "#src/message-format";
import { formatReadWindow } from "#src/message-read-format";

function message(overrides: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    sequence: 1,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target: "#general",
    body: "hello there",
    createdAt: "2026-09-07T10:00:00Z",
    attachments: [],
    ...overrides,
  };
}

test("a forwarded message reads as its note, its attachments, and the quoted original", () => {
  const forwarded = message({
    body: "see this",
    attachments: [
      { id: "att-1", fileName: "plan.pdf", contentType: "application/pdf", sizeBytes: 3 },
    ],
    forwardedMessages: [
      {
        from: "#product",
        sender: "@grace",
        sentAt: "2026-09-06T09:30:00Z",
        body: "ship friday\nnot monday",
        attachments: ["att-1"],
      },
    ],
  });
  const expected =
    "[target=#general msg=aaaaaaaa-0000 time=2026-09-07 10:00:00Z type=human] @ada: see this" +
    " [1 attachment: plan.pdf (id:att-1) — use `coforge attachment view --id <attachmentId> --output <path>` to download]" +
    "\n[forwarded from #product by @grace at 2026-09-06 09:30:00Z]\n> ship friday\n> not monday";
  expect(formatMessageLine(forwarded)).toBe(expected);
  const read = formatReadWindow("#general", {
    messages: [forwarded],
    hasOlder: false,
    hasNewer: false,
  });
  expect(read).toContain(
    "[forwarded from #product by @grace at 2026-09-06 09:30:00Z]\n> ship friday",
  );
  expect(read).toContain("(id:att-1)");
});

test("a forward of several reads each original in order, from the list alone", () => {
  const first = {
    from: "#product",
    sender: "@grace",
    sentAt: "2026-09-06T09:30:00Z",
    body: "ship friday",
    attachments: [],
  };
  const second = { ...first, sender: "@ada", sentAt: "2026-09-06T09:31:00Z", body: "agreed" };
  // The wire's `forwarded` (the first again, for older CLIs) is not read: no original twice.
  const several = message({ body: "", forwarded: first, forwardedMessages: [first, second] });
  expect(formatMessageLine(several)).toEndWith(
    "\n[forwarded from #product by @grace at 2026-09-06 09:30:00Z]\n> ship friday" +
      "\n[forwarded from #product by @ada at 2026-09-06 09:31:00Z]\n> agreed",
  );
  expect(formatMessageLine(several).match(/\[forwarded from/g)).toHaveLength(2);
});
