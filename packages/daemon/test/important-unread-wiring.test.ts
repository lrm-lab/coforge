import { expect, test } from "bun:test";
import {
  composeImportantUnreadReminder,
  importantUnreadNoticeText,
  type ImportantUnreadWiringPorts,
} from "#src/daemon-runtime/important-unread-wiring";
import {
  ImportantUnreadNotices,
  type ImportantUnreadNotice,
} from "#src/daemon-runtime/important-unread-notice";
import { ImportantUnreadReminder } from "#src/daemon-runtime/important-unread-reminder";

// The loop decides when to speak; this binds it to the daemon so what it says is a nudge that
// names where the messages are, and a session that is gone is a refusal (so the retry stays), not
// a success (task #14).

const mention = (sequence: number, target = "#coforge-backend") => ({
  agentId: "agent-a",
  conversationId: "conversation-1",
  target,
  sequence,
  mentionsAgent: true,
});

const notice = (overrides: Partial<ImportantUnreadNotice> = {}): ImportantUnreadNotice => ({
  agentId: "agent-a",
  key: "seq:12",
  highestSequence: 12,
  conversations: [
    { conversationId: "conversation-1", target: "#coforge-backend", firstSequence: 12, count: 1 },
  ],
  attempts: 0,
  ...overrides,
});

function harness(overrides: Partial<ImportantUnreadWiringPorts> = {}) {
  const written: { agentId: string; text: string }[] = [];
  const reported: string[] = [];
  const saved: ImportantUnreadNotice[] = [];
  const cleared: string[] = [];
  const reminder = composeImportantUnreadReminder({
    store: {
      save: (value) => {
        saved.push(value);
      },
      clear: (agentId) => {
        cleared.push(agentId);
      },
      list: () => [],
    },
    session: () => ({
      notify: async (text: string) => {
        written.push({ agentId: "agent-a", text });
      },
    }),
    unread: () => [],
    report: (agentId) => {
      reported.push(agentId);
    },
    ...overrides,
  });
  return { reminder, written, reported, saved, cleared };
}

test("a notice names where the unread messages are, and how many", () => {
  expect(
    importantUnreadNoticeText(notice(), [
      { target: "#coforge-backend", count: 2 },
      { target: "@coforge-raft", count: 1 },
    ]),
  ).toBe(
    "Still not read: #coforge-backend (2), @coforge-raft (1). Run `coforge inbox check` to see them.",
  );
});

test("a retry outliving the index's own count still says where to look", () => {
  // A restart clears the index's per-target counts; the batch's own conversations remain.
  expect(importantUnreadNoticeText(notice(), [])).toContain("#coforge-backend (1)");
});

test("an important delivery is written into the running session, and recorded", () => {
  const { reminder, written, saved } = harness();
  reminder.observeDeliveries([mention(12)]);
  expect(written).toHaveLength(1);
  expect(written[0]!.text).toContain("#coforge-backend");
  expect(saved.at(-1)).toMatchObject({ key: "seq:12", attempts: 1 });
});

test("a session that is gone is a refusal, so the batch stays due instead of being counted", () => {
  const { reminder, written, saved } = harness({ session: () => undefined });
  reminder.observeDeliveries([mention(12)]);
  expect(written).toHaveLength(0);
  // Only the observe's own record was saved: no successful write was recorded.
  expect(saved).toHaveLength(1);
  expect(saved[0]!.attempts).toBe(0);
});

test("best-effort traffic never reaches the process through this wiring", () => {
  const { reminder, written } = harness();
  reminder.observeDeliveries([{ ...mention(12), mentionsAgent: false }]);
  expect(written).toHaveLength(0);
});

test("a retry counts what has arrived since, not the first attempt's snapshot", () => {
  // Fifteen minutes later the queue has moved on: the second write has to describe the unread at
  // that moment, or the Agent is told about two messages and finds four (raft, #14 seq 48).
  let clock = 1_000;
  let unread = 1;
  const written: string[] = [];
  const reminder = new ImportantUnreadReminder(
    new ImportantUnreadNotices(),
    { save: () => undefined, clear: () => undefined, list: () => [] },
    {
      compose: (_agentId, _notice, deliveries) => `Inbox: ${deliveries.length + unread - 1}`,
      write: (_agentId, _notice, text) => {
        written.push(text ?? "standing text");
        return true;
      },
      report: () => undefined,
    },
    () => clock,
  );
  reminder.observeDeliveries([mention(12)]);
  clock += 60_000;
  // Two more arrived in the same conversation while the batch waited: the retry merges them.
  reminder.observeDeliveries([mention(13), mention(14)]);
  unread = 3;
  reminder.flushDue();
  // Each arrival is its own reason to speak, and each write counts everything known by then: no
  // attempt repeats the snapshot an earlier one took.
  expect(written).toEqual(["Inbox: 1", "Inbox: 2", "Inbox: 3"]);
});

test("a record taken over after a restart has no words of its own, so the standing text is used", () => {
  const { reminder, written } = harness({
    store: {
      save: () => undefined,
      clear: () => undefined,
      list: () => [notice({ attempts: 1 })],
    },
  });
  reminder.restore();
  reminder.flushDue();
  expect(written).toHaveLength(1);
  expect(written[0]!.text).toContain("Still not read");
});
