import { expect, test } from "bun:test";
import { inboxPreviewLimit } from "#src/daemon-runtime/inbox-preview";
import { IMPORTANT_UNREAD_RETRY_DELAYS_MS } from "#src/daemon-runtime/important-unread-notice";
import { captureDaemonLogs } from "./log-capture";
import { delivery } from "./fixtures/attention-delivery";
import { settled, unreadLoop } from "./fixtures/unread-loop";

// The reliable tier has one writer now, so a delivery the loop takes in and never gets in front of
// the model is a notice that went missing with nobody else to write it. Each such delivery earns
// exactly one warning, with the reason it was dropped (task #14, `agent.inbox_notice.unobserved`).

const warningsIn = (records: readonly { properties: Record<string, unknown> }[]) =>
  records
    .filter((record) => record.properties.event === "agent.inbox_notice.unobserved")
    .map((record) => record.properties);

test("a delivery pushed out of the batch before any attempt is reported once", async () => {
  const { records } = await captureDaemonLogs(async () => {
    // No session to write into, so nothing is ever accepted and the batch only grows.
    const { index } = unreadLoop({ writable: false });
    const limit = inboxPreviewLimit();
    for (let sequence = 1; sequence <= limit + 1; sequence += 1)
      await index.receive({
        ...delivery(`busy-${sequence}`),
        target: "#team",
        sequence,
        mentionsAgent: true,
      });
    index.clearAgent("agent-1");
  });
  const warnings = warningsIn(records);
  // Only the oldest delivery left the batch: the notice can no longer name it, and nothing else
  // would ever mention it.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    agent_id: "agent-1",
    delivery_id: "delivery-busy-1",
    attempts: 0,
    reason: "superseded",
  });
});

test("a delivery read before its first attempt is reported as such", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const loop = unreadLoop({ writable: false });
    await loop.index.receive({
      ...delivery("read-first"),
      target: "#team",
      sequence: 3,
      mentionsAgent: true,
    });
    // The Agent's read position moved past the batch it was never told about.
    loop.reminder.consumed("agent-1", 3);
    return loop;
  });
  expect(result.records.size).toBe(0);
  expect(warningsIn(records)).toHaveLength(1);
  expect(warningsIn(records)[0]).toMatchObject({
    delivery_id: "delivery-read-first",
    attempts: 0,
    reason: "read_before_attempt",
  });
});

test("a batch whose retries ran out reports each delivery it was still holding, once", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const loop = unreadLoop();
    await loop.index.receive({
      ...delivery("spent"),
      target: "#team",
      sequence: 4,
      mentionsAgent: true,
    });
    for (const delay of IMPORTANT_UNREAD_RETRY_DELAYS_MS) {
      loop.clock.nowMs += delay;
      loop.reminder.flushDue();
      await settled();
    }
    // A sweep after the report adds nothing.
    loop.reminder.flushDue();
    return loop;
  });
  await settled();
  expect(result.reported).toEqual(["agent-1"]);
  const warnings = warningsIn(records);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    agent_id: "agent-1",
    delivery_id: "delivery-spent",
    attempts: IMPORTANT_UNREAD_RETRY_DELAYS_MS.length + 1,
    reason: "unread",
  });
});
