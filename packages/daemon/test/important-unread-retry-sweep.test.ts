import { expect, test } from "bun:test";
import { IMPORTANT_UNREAD_RETRY_DELAYS_MS } from "#src/daemon-runtime/important-unread-notice";
import { ImportantUnreadSweep } from "#src/daemon-runtime/important-unread-sweep";
import { delivery } from "./fixtures/attention-delivery";
import { settled, unreadLoop } from "./fixtures/unread-loop";
import { captureDaemonLogs } from "./log-capture";

// The retry sweep and the read funnel, over the real wiring: an attention index that hands a
// reliable delivery to the unread loop, the loop that writes and retries it, and the sweep that is
// what drives those retries (task #14). Until the sweep existed nothing called `flushDue`, so a
// refused notice was never repeated and a batch nobody read never ran out; the assertions below are
// on the production entry points — `index.receive`, `index.announce`, the loop's cursor write, and
// `ImportantUnreadSweep.sweep` — never on the loop in isolation.

const warningsIn = (records: readonly { properties: Record<string, unknown> }[]) =>
  records
    .filter((record) => record.properties.event === "agent.inbox_notice.unobserved")
    .map((record) => record.properties);

test("a notice the session refused is retried by the next sweep, as a whole notice", async () => {
  let refusals = 1;
  const loop = unreadLoop({ refuse: () => refusals-- > 0 });
  const sweep = new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() });
  const message = { ...delivery("refused"), target: "@agent-1", sequence: 2 };
  // The first attempt is the delivery's own, and it fails: a delivery nobody was told about is not
  // one the daemon acknowledges.
  await expect(loop.index.receive(message)).rejects.toThrow();
  expect(loop.notices).toHaveLength(0);
  // Nothing was recorded as written, so the retry is due at once — a refusal schedules nothing.
  expect(loop.records.get("agent-1")).toMatchObject({ attempts: 0 });
  sweep.sweep();
  await settled();
  expect(loop.loopNotices).toHaveLength(1);
  // The retry is the composed notice naming what is unread, not the standing "Still waiting"
  // pointer a batch with nothing to say falls back to.
  expect(loop.loopNotices[0]).toStartWith("[CoForge inbox notice:");
  expect(loop.loopNotices[0]).toContain("@agent-1 1 new message");
  expect(loop.loopNotices[0]).not.toContain("Still waiting");
  expect(loop.records.get("agent-1")).toMatchObject({
    attempts: 1,
    nextAttemptAtMs: loop.clock.nowMs + IMPORTANT_UNREAD_RETRY_DELAYS_MS[0],
  });
  // The write above scheduled the next attempt, and a tick before it is due writes nothing: the
  // state machine decides the moment, the sweep only looks.
  sweep.sweep();
  await settled();
  expect(loop.loopNotices).toHaveLength(1);
  loop.clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  sweep.sweep();
  await settled();
  expect(loop.loopNotices).toHaveLength(2);
  expect(loop.records.get("agent-1")).toMatchObject({ attempts: 2 });
});

test("a batch written on every attempt and never read ends as exhausted, with one warning", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const loop = unreadLoop();
    const sweep = new ImportantUnreadSweep({ flushDue: () => loop.reminder.flushDue() });
    await loop.index.receive({ ...delivery("never-read"), target: "@agent-1", sequence: 2 });
    await settled();
    // One write, then one per delay the schedule holds: four attempts, then nothing is due.
    for (const delay of IMPORTANT_UNREAD_RETRY_DELAYS_MS) {
      loop.clock.nowMs += delay;
      sweep.sweep();
      await settled();
    }
    // A sweep after the batch ran out adds neither a write nor a second report.
    sweep.sweep();
    await settled();
    return loop;
  });
  expect(result.loopNotices).toHaveLength(IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1);
  // The watchdog's cue, once per batch: one report to the Activity, and one warning per delivery
  // the loop was still holding.
  expect(result.reported).toEqual(["agent-1"]);
  const warnings = warningsIn(records);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    agent_id: "agent-1",
    delivery_id: "delivery-never-read",
    attempts: IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1,
    reason: "exhausted",
  });
});

test("a read stops the retries, and a delivery read before any attempt is reported as such", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    // No session yet: the batch is taken in and waits, and no attempt reaches the model.
    const loop = unreadLoop({ writable: false, cursor: true });
    await loop.index.receive({ ...delivery("read-first"), target: "@agent-1", sequence: 3 });
    // The Agent reads it: the index's cursor moves, and the composition's one write of that cursor
    // is where the loop hears it.
    loop.index.recordHistoryRead("agent-1", {
      spelling: "@agent-1",
      target: "@agent-1",
      shown: [3],
      through: 3,
    });
    return loop;
  });
  // The batch is settled: its record is gone, so no sweep has anything to retry.
  expect(result.records.size).toBe(0);
  const warnings = warningsIn(records);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    delivery_id: "delivery-read-first",
    attempts: 0,
    reason: "read_before_attempt",
  });
});
