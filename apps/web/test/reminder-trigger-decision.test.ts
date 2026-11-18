import { expect, test } from "bun:test";
import { REMINDER_TRIGGER_WAKES_PER_HOUR } from "@lrm/coforge-sdk/internal";
import {
  decideReminderTrigger,
  type ReminderTriggerState,
} from "#src/server/reminders/reminder-trigger-decision.server";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 8, minutes));
const quiet: ReminderTriggerState = { windowEndsAt: null, pendingCount: 0, firstPendingAt: null };
const base = { level: "wake" as const, mergeWindowSeconds: 600, wakesInLastHour: [] as Date[] };

test("the first trigger of a key wakes and opens the merge window", () => {
  const decision = decideReminderTrigger({ ...base, now: at(0), state: quiet });
  expect(decision.outcome).toBe("woke");
  expect(decision.receipt).toEqual({
    triggerCount: 1,
    firstTriggeredAt: at(0),
    lastTriggeredAt: at(0),
    nextWakeAllowedAt: at(10),
  });
  expect(decision.nextState).toEqual({
    windowEndsAt: at(10),
    pendingCount: 0,
    firstPendingAt: null,
  });
});

test("a trigger inside the window is recorded, not sent, and does not move the window", () => {
  const opened = decideReminderTrigger({ ...base, now: at(0), state: quiet }).nextState;
  const second = decideReminderTrigger({ ...base, now: at(3), state: opened });
  expect(second.outcome).toBe("merged");
  expect(second.receipt).toEqual({
    triggerCount: 1,
    firstTriggeredAt: at(3),
    lastTriggeredAt: at(3),
    nextWakeAllowedAt: at(10),
  });
  const third = decideReminderTrigger({ ...base, now: at(7), state: second.nextState });
  expect(third.receipt).toEqual({
    triggerCount: 2,
    firstTriggeredAt: at(3),
    lastTriggeredAt: at(7),
    nextWakeAllowedAt: at(10),
  });
  expect(third.nextState.windowEndsAt).toEqual(at(10));
});

test("the first trigger after the window wakes and carries the merged ones, and nothing is sent when the window ends", () => {
  let state = decideReminderTrigger({ ...base, now: at(0), state: quiet }).nextState;
  state = decideReminderTrigger({ ...base, now: at(3), state }).nextState;
  state = decideReminderTrigger({ ...base, now: at(7), state }).nextState;
  const after = decideReminderTrigger({ ...base, now: at(25), state });
  expect(after.outcome).toBe("woke");
  expect(after.receipt).toEqual({
    triggerCount: 3,
    firstTriggeredAt: at(3),
    lastTriggeredAt: at(25),
    nextWakeAllowedAt: at(35),
  });
  expect(after.nextState).toEqual({ windowEndsAt: at(35), pendingCount: 0, firstPendingAt: null });
});

test("a trigger exactly at the window's end is allowed to wake", () => {
  const state = { windowEndsAt: at(10), pendingCount: 0, firstPendingAt: null };
  expect(decideReminderTrigger({ ...base, now: at(10), state }).outcome).toBe("woke");
  expect(
    decideReminderTrigger({ ...base, now: new Date(at(10).getTime() - 1), state }).outcome,
  ).toBe("merged");
});

test("level log is recorded and never touches the wake state", () => {
  const state = { windowEndsAt: at(10), pendingCount: 2, firstPendingAt: at(1) };
  const decision = decideReminderTrigger({ ...base, level: "log", now: at(30), state });
  expect(decision.outcome).toBe("recorded");
  expect(decision.receipt).toEqual({
    triggerCount: 1,
    firstTriggeredAt: at(30),
    lastTriggeredAt: at(30),
  });
  expect(decision.nextState).toEqual(state);
});

test("past the hourly wake cap a trigger is throttled until the oldest wake leaves the hour", () => {
  const wakes = Array.from({ length: REMINDER_TRIGGER_WAKES_PER_HOUR }, (_, index) =>
    at(index * 5),
  );
  const decision = decideReminderTrigger({
    ...base,
    now: at(40),
    state: { windowEndsAt: at(30), pendingCount: 0, firstPendingAt: null },
    wakesInLastHour: wakes,
  });
  expect(decision.outcome).toBe("throttled");
  expect(decision.receipt).toEqual({
    triggerCount: 1,
    firstTriggeredAt: at(40),
    lastTriggeredAt: at(40),
    nextWakeAllowedAt: at(60),
  });
  expect(decision.nextState.windowEndsAt).toEqual(at(30));
  expect(decision.nextState.pendingCount).toBe(1);
});

test("a wake that has left the hour no longer counts against the cap", () => {
  const wakes = [
    at(-70),
    ...Array.from({ length: REMINDER_TRIGGER_WAKES_PER_HOUR - 1 }, (_, i) => at(i)),
  ];
  const decision = decideReminderTrigger({
    ...base,
    now: at(10),
    state: quiet,
    wakesInLastHour: wakes,
  });
  expect(decision.outcome).toBe("woke");
});

test("a merged trigger reports the later of the window's end and the time the hourly cap lifts", () => {
  const wakes = Array.from({ length: REMINDER_TRIGGER_WAKES_PER_HOUR }, (_, index) =>
    at(index * 5),
  );
  const decision = decideReminderTrigger({
    ...base,
    now: at(26),
    state: { windowEndsAt: at(30), pendingCount: 0, firstPendingAt: null },
    wakesInLastHour: wakes,
  });
  expect(decision.outcome).toBe("merged");
  expect(decision.receipt.nextWakeAllowedAt).toEqual(at(60));
});

test("a merged trigger keeps the window's end when the cap will have lifted by then", () => {
  const wakes = Array.from({ length: REMINDER_TRIGGER_WAKES_PER_HOUR }, (_, index) =>
    at(-55 + index),
  );
  const decision = decideReminderTrigger({
    ...base,
    now: at(-2),
    state: { windowEndsAt: at(10), pendingCount: 0, firstPendingAt: null },
    wakesInLastHour: wakes,
  });
  expect(decision.outcome).toBe("merged");
  expect(decision.receipt.nextWakeAllowedAt).toEqual(at(10));
});
