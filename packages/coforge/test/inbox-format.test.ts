import { expect, test } from "bun:test";
import { formatInboxCheck } from "#src/inbox-format";

test("inbox check renders unread conversations and app items as text", () => {
  const output = formatInboxCheck({
    entries: [
      {
        kind: "message_target",
        messageTarget: {
          target: "@ada",
          pendingCount: 2,
          latestSenderHandle: "ada",
          flags: ["dm"],
        },
      },
      {
        kind: "message_target",
        messageTarget: {
          target: "#general",
          pendingCount: 1,
          latestSenderHandle: "scout",
          flags: ["channel", "non_member_mention"],
        },
      },
      { kind: "app", app: { title: "Reminder", summary: "Due now" } },
    ],
  });
  expect(output).toContain("Inbox: 2 unread conversation(s) (1 DMs, 1 with mentions).");
  expect(output).toContain("@ada · 2 unread · latest @ada");
  expect(output).toContain("#general · 1 unread · mentions you · latest @scout");
  expect(output).toContain('open: coforge message read --target "@ada"');
  expect(output).toContain("App items pending: 1.");
  expect(output).toContain("- Reminder: Due now");
  expect(output).toContain('Next: coforge message read --target "@ada"');
});

test("inbox check preserves machine JSON behind --json", () => {
  const output = formatInboxCheck(
    {
      entries: [
        {
          kind: "message_target",
          messageTarget: {
            target: "#general",
            pendingCount: 1,
            firstPendingSequence: 4,
            latestSequence: 4,
          },
        },
      ],
    },
    true,
  );
  expect(output).toContain('"pendingCount":1');
  expect(output).not.toContain("firstPendingSequence");
  expect(output).not.toContain("latestSequence");
});
