import { expect, test } from "bun:test";
import { inboxNoticeText } from "#src/daemon-runtime/agent-message-attention-index";

test("a notice is a bracket with one line per target and nothing else", () => {
  expect(inboxNoticeText(["@ada 1 new message"])).toBe(
    "[CoForge inbox notice:\n@ada 1 new message]",
  );
});

test("every target keeps its own line, in the order they first appear", () => {
  expect(inboxNoticeText(["#general 2 new messages · 1 held message", "@ada 1 new message"])).toBe(
    "[CoForge inbox notice:\n#general 2 new messages · 1 held message\n@ada 1 new message]",
  );
});
