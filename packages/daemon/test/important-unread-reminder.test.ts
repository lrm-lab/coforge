import { expect, test } from "bun:test";
import {
  IMPORTANT_UNREAD_RETRY_DELAYS_MS,
  ImportantUnreadNotices,
  type ImportantUnreadNotice,
} from "#src/daemon-runtime/important-unread-notice";
import { ImportantUnreadReminder } from "#src/daemon-runtime/important-unread-reminder";

// The loop is what keeps every caller from deciding again when to write (task #14): the state owns
// the identity and the schedule, the record owns what a restart needs, and this only sequences
// them. The tests drive it the way the delivery path will — a delivery arrives, the schedule
// elapses, the Agent reads — and watch what reaches the process.

function harness(options: Readonly<{ accept?: () => boolean }> = {}) {
  const written: ImportantUnreadNotice[] = [];
  const reported: string[] = [];
  const records = new Map<string, ImportantUnreadNotice>();
  const clock = { nowMs: 1_000_000 };
  const reminder = new ImportantUnreadReminder(
    new ImportantUnreadNotices(),
    {
      save: (notice) => void records.set(notice.agentId, notice),
      clear: (agentId) => void records.delete(agentId),
      list: () => [...records.values()],
    },
    {
      write: (_agentId, notice) => {
        if (options.accept?.() === false) return false;
        written.push(notice);
        return true;
      },
      report: (agentId) => void reported.push(agentId),
    },
    () => clock.nowMs,
  );
  return { reminder, written, reported, records, clock };
}

const mention = {
  agentId: "agent-a",
  conversationId: "conversation-a",
  target: "#general",
  sequence: 10,
  mentionsAgent: true,
};

test("an important delivery is written once, and its record keeps the batch", () => {
  const { reminder, written, records } = harness();
  reminder.observeDeliveries([mention]);
  expect(written).toHaveLength(1);
  expect(records.get("agent-a")).toMatchObject({ key: "seq:10", attempts: 1 });
  // The sweep has nothing to do until the backoff elapses.
  reminder.flushDue();
  expect(written).toHaveLength(1);
});

test("best-effort traffic never reaches the process through this loop", () => {
  const { reminder, written, records } = harness();
  reminder.observeDeliveries([{ ...mention, mentionsAgent: false }]);
  expect(written).toEqual([]);
  expect(records.size).toBe(0);
});

test("a retry waits its backoff, and a refused write is tried again", () => {
  let accept = false;
  const { reminder, written, records, clock } = harness({ accept: () => accept });
  reminder.observeDeliveries([mention]);
  // Refused: nothing recorded as written, so the next sweep tries again.
  expect(written).toEqual([]);
  expect(records.get("agent-a")?.attempts).toBe(0);
  accept = true;
  clock.nowMs += 1_000;
  reminder.flushDue();
  expect(written).toHaveLength(1);
  expect(records.get("agent-a")?.attempts).toBe(1);
  clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0] - 1;
  reminder.flushDue();
  expect(written).toHaveLength(1);
  clock.nowMs += 1;
  reminder.flushDue();
  expect(written).toHaveLength(2);
  expect(written[1]?.key).toBe(written[0]?.key);
});

test("the error is raised once when the retries are used up, not on every sweep", () => {
  const { reminder, written, reported, records, clock } = harness();
  reminder.observeDeliveries([mention]);
  for (const delay of IMPORTANT_UNREAD_RETRY_DELAYS_MS) {
    clock.nowMs += delay;
    reminder.flushDue();
  }
  expect(written).toHaveLength(IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1);
  expect(records.get("agent-a")?.attempts).toBe(IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1);
  reminder.flushDue();
  expect(reported).toEqual(["agent-a"]);
});

test("reading the batch clears the record, and a new batch starts its own retries", () => {
  const { reminder, written, records } = harness();
  reminder.observeDeliveries([mention]);
  // A check that stopped short of these messages is not a read.
  reminder.consumed("agent-a", 9);
  expect(records.get("agent-a")).toBeDefined();
  reminder.consumed("agent-a", 10);
  expect(records.get("agent-a")).toBeUndefined();
  // A new message is a new batch: it is written at once, with its own attempts.
  reminder.observeDeliveries([{ ...mention, sequence: 12 }]);
  expect(written).toHaveLength(2);
  expect(records.get("agent-a")).toMatchObject({ key: "seq:12", attempts: 1 });
});

test("a restarted Daemon takes the record over and tells the Agent once", () => {
  const { reminder, written, records } = harness();
  reminder.observeDeliveries([mention]);
  const pending = records.get("agent-a")!;
  // The next process starts with the record the last one left.
  const next = new ImportantUnreadReminder(
    new ImportantUnreadNotices(),
    { save: () => undefined, clear: () => undefined, list: () => [pending] },
    {
      write: (_agentId, notice) => {
        written.push(notice);
        return true;
      },
      report: () => undefined,
    },
    () => (pending.nextAttemptAtMs ?? 0) + 1,
  );
  next.restore();
  // Restoring only records it: the sweep is what tells the Agent.
  expect(written).toHaveLength(1);
  next.flushDue();
  expect(written).toHaveLength(2);
});
