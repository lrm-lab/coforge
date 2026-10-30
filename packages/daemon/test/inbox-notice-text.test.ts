import { expect, test } from "bun:test";
import { inboxNoticeText } from "#src/daemon-runtime/inbox-notice-text";

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

test("a notice that lists a task conversation says how to read and reply to one", () => {
  for (const row of ["#general:#7 2 new messages", "dm:@ada:#3 1 new message"])
    expect(inboxNoticeText(["#general 1 new message", row])).toBe(
      `[CoForge inbox notice:\n#general 1 new message\n${row}\nA task conversation (a '#channel:#7' target) is read with 'coforge task read <ref> --unread' and replied to with 'coforge task reply <ref>'.]`,
    );
});

test("a thread target is not a task conversation", () => {
  expect(inboxNoticeText(["#general:abcd1234 1 new message"])).not.toContain("task");
});

test("the startup catch-up notice carries the task sentence for a CLI Agent only", async () => {
  const { agentStartupCatchupInput } = await import("#src/agent-runtime/agent-startup");
  const rows = ["#general:#7 1 new message"];
  expect(agentStartupCatchupInput(rows)).toContain("coforge task read <ref> --unread");
  expect(agentStartupCatchupInput(rows, true)).not.toContain("coforge task read");
  expect(agentStartupCatchupInput(["#general 1 new message"])).not.toContain("coforge task read");
});
