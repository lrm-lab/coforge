import { expect, test } from "bun:test";
import {
  IMPORTANT_UNREAD_RETRY_DELAYS_MS,
  ImportantUnreadNotices,
} from "#src/daemon-runtime/important-unread-notice";

// One Agent, one state (task #14): the daemon guarantees the Agent eventually knows it has
// important unread work, not that every message arrives. The identity is the batch's highest
// sequence, so new traffic merges into the state instead of producing another notice.

const mention = {
  agentId: "agent-a",
  conversationId: "conversation-a",
  target: "#general",
  sequence: 10,
  mentionsAgent: true,
};

test("best-effort traffic never creates a state", () => {
  const notices = new ImportantUnreadNotices();
  expect(notices.observe({ ...mention, mentionsAgent: false })).toBeUndefined();
  expect(notices.pending("agent-a")).toBeUndefined();
  expect(notices.dueForWrite("agent-a")).toBe(false);
});

test("a new batch is due at once, and the same batch is not written again while it stands", () => {
  const notices = new ImportantUnreadNotices();
  const first = notices.observe(mention);
  expect(first).toMatchObject({ key: "seq:10", attempts: 0 });
  expect(notices.dueForWrite("agent-a", 1_000)).toBe(true);
  notices.recordWritten("agent-a", 1_000);
  // Second thoughts about the same delivery change nothing: the batch identity already covers it.
  expect(notices.observe({ ...mention, sequence: 9 })).toBeUndefined();
  expect(notices.dueForWrite("agent-a", 1_000)).toBe(false);
});

test("a second important message in the same conversation merges instead of adding a notice", () => {
  const notices = new ImportantUnreadNotices();
  notices.observe(mention);
  const merged = notices.observe({ ...mention, sequence: 12 });
  expect(merged?.conversations).toEqual([
    { conversationId: "conversation-a", target: "#general", firstSequence: 10, count: 2 },
  ]);
  // A new identity is new to say, so its attempts start again.
  expect(merged?.attempts).toBe(0);
  expect(notices.dueForWrite("agent-a", Date.now())).toBe(true);
});

test("retries are bounded, and exhaust after the last delay", () => {
  const notices = new ImportantUnreadNotices();
  notices.observe(mention);
  let now = 1_000_000;
  for (const [index, delay] of IMPORTANT_UNREAD_RETRY_DELAYS_MS.entries()) {
    expect(notices.dueForWrite("agent-a", now)).toBe(true);
    const written = notices.recordWritten("agent-a", now);
    expect(written?.attempts).toBe(index + 1);
    expect(written?.nextAttemptAtMs).toBe(now + delay);
    expect(notices.dueForWrite("agent-a", now + delay - 1)).toBe(false);
    expect(notices.retriesExhausted("agent-a")).toBe(false);
    now += delay;
  }
  // The write that used the last delay schedules nothing more: the watchdog owns it from here.
  const last = notices.recordWritten("agent-a", now);
  expect(last?.attempts).toBe(IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1);
  expect(last?.nextAttemptAtMs).toBeUndefined();
  expect(notices.dueForWrite("agent-a", now)).toBe(false);
  expect(notices.retriesExhausted("agent-a")).toBe(true);
});

test("only a read position past the batch settles it", () => {
  const notices = new ImportantUnreadNotices();
  notices.observe(mention);
  notices.observe({ ...mention, sequence: 14 });
  // A check that stopped before these messages read nothing of them.
  expect(notices.settle("agent-a", 13)).toBe(false);
  expect(notices.pending("agent-a")).toBeDefined();
  expect(notices.settle("agent-a", 14)).toBe(true);
  expect(notices.pending("agent-a")).toBeUndefined();
  expect(notices.dueForWrite("agent-a")).toBe(false);
});

test("a restored record is due again, so a restarted Daemon tells the Agent once", () => {
  const notices = new ImportantUnreadNotices();
  notices.restore({
    agentId: "agent-b",
    key: "seq:31",
    highestSequence: 31,
    conversations: [{ conversationId: "conversation-b", firstSequence: 29, count: 2 }],
    attempts: 2,
    writtenAtMs: 5_000,
    nextAttemptAtMs: 5_000 + IMPORTANT_UNREAD_RETRY_DELAYS_MS[1],
  });
  expect(notices.pending("agent-b")?.key).toBe("seq:31");
  // Raft's `turnInProgress`/watchdog split (raft seq 26): the watchdog does not wait for retries,
  // and a fresh process does not wait for the old backoff either.
  expect(notices.dueForWrite("agent-b", 6_000)).toBe(false);
  notices.clear("agent-b");
  expect(notices.pending("agent-b")).toBeUndefined();
  // A record with nothing in it is not a state.
  notices.restore({
    agentId: "agent-c",
    key: "seq:0",
    highestSequence: 0,
    conversations: [],
    attempts: 0,
  });
  expect(notices.pending("agent-c")).toBeUndefined();
});
