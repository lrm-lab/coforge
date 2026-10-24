import { expect, test } from "bun:test";
import type { AgentInboxItem } from "@lrm/coforge-sdk/agent";
import { formatInboxCheck, type InboxCheckResult } from "#src/inbox-format";

const NOW = Date.parse("2026-10-25T12:00:00Z");

const item = (over: Partial<AgentInboxItem>): AgentInboxItem => ({
  kind: "channel",
  target: "#general",
  unread: 1,
  mentions: 0,
  latestAt: "2026-10-25T11:00:00Z",
  latestSenderName: "scout",
  lastReadSeq: 4,
  ...over,
});

const result = (over: Partial<InboxCheckResult> = {}): InboxCheckResult => ({
  view: "unread",
  list: {
    ok: true,
    view: "unread",
    items: [],
    totals: { conversations: 0, dms: 0, mentions: 0 },
    hasMore: false,
    nextBefore: null,
  },
  pendingRows: [],
  appItems: [],
  ...over,
});

test("renders unread rows with mentions, age and the read command", () => {
  const output = formatInboxCheck(
    result({
      list: {
        ...result().list,
        items: [
          item({
            target: "@ada",
            unread: 2,
            latestSenderName: "ada",
            latestAt: "2026-10-25T11:58:00Z",
            lastReadSeq: 0,
          }),
          item({ mentions: 2 }),
        ],
        totals: { conversations: 2, dms: 1, mentions: 1 },
      },
    }),
    NOW,
  );
  expect(output).toContain(
    "Inbox: 2 unread conversations (1 DM, 1 with mentions). Newest activity first.",
  );
  expect(output).toContain("@ada · 2 unread · latest @ada 2m ago");
  expect(output).toContain("#general · 1 unread · mentions you 2x · latest @scout 1h ago");
  // A read position of 0 is still printed: without it the read opens the latest page, not the unread.
  expect(output).toContain('  open: coforge message read --target "@ada" --after 0\n');
  expect(output).toContain('open: coforge message read --target "#general" --after 4');
  expect(output).toContain(
    'Next: open the first conversation above: coforge message read --target "@ada"',
  );
});

test("a followed thread is a row like a conversation, read from its own position", () => {
  const output = formatInboxCheck(
    result({
      list: {
        ...result().list,
        items: [
          item({
            kind: "thread",
            target: "#general:3f4b1fd4-aaaa",
            unread: 3,
            mentions: 1,
            lastReadSeq: 0,
          }),
        ],
        totals: { conversations: 1, dms: 0, mentions: 1 },
      },
    }),
    NOW,
  );
  expect(output).toContain(
    "#general:3f4b1fd4-aaaa · 3 unread · mentions you · latest @scout 1h ago",
  );
  expect(output).toContain(
    'open: coforge message read --target "#general:3f4b1fd4-aaaa" --after 0',
  );
});

test("shows More with the view and nothing-unread when empty", () => {
  expect(formatInboxCheck(result(), NOW)).toContain("Inbox: nothing unread.");
  const output = formatInboxCheck(
    result({
      view: "mentions",
      before: 900,
      list: {
        ...result().list,
        view: "mentions",
        items: [item({ mentions: 1 })],
        totals: { conversations: 3, dms: 0, mentions: 2 },
        hasMore: true,
        nextBefore: 700,
      },
    }),
    NOW,
  );
  expect(output).toContain(
    "Inbox: 2 conversations with unread mentions (of 3 unread conversations).",
  );
  expect(output).toContain("Activity before the More: cursor, newest first.");
  expect(output).toContain("More: coforge inbox check --view mentions --before 700");
});

test("lists undelivered-only conversations first and annotates listed ones", () => {
  const output = formatInboxCheck(
    result({
      list: {
        ...result().list,
        items: [item({})],
        totals: { conversations: 1, dms: 0, mentions: 0 },
      },
      pendingRows: [
        { target: "#general", pendingCount: 3, flags: [] },
        {
          target: "#ops",
          pendingCount: 1,
          flags: ["non_member_mention"],
          latestSenderHandle: "bot",
          firstPendingSequence: 9,
        },
        { target: "#new", pendingCount: 1, flags: [], firstPendingSequence: 1 },
      ],
    }),
    NOW,
  );
  expect(output.indexOf("#ops")).toBeLessThan(output.indexOf("#general"));
  expect(output).toContain("#ops · 1 new, not yet delivered · mentions you · latest @bot");
  expect(output).toContain('--target "#ops" --after 8');
  expect(output).toContain('--target "#new" --after 0');
  expect(output).toContain("#general · 1 unread · 3 new, not yet delivered");
});

test("reports App items and a daemon failure beside the list", () => {
  const output = formatInboxCheck(
    result({
      appItems: [{ title: "Reminder", summary: "Due now" }],
      daemonError: "boom",
    }),
    NOW,
  );
  expect(output).toContain("App items pending: 1.\n- Reminder: Due now");
  expect(output).toContain("Daemon pending buffer unavailable (boom)");
});
