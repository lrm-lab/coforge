import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import type { UnrefTimerSchedule } from "#src/daemon-runtime/unref-timer";
import { RuntimeReadyWaitWatch } from "#src/daemon-runtime/runtime-ready-wait";
import { captureDaemonLogs } from "./log-capture";

afterEach(() => jest.useRealTimers());

/** A clock the test drives: the watch arms it and the test decides when it fires, and each fire
 * re-arms, exactly as the real one-shot timer does. */
function manualClock() {
  const pending: Array<() => Promise<void>> = [];
  const schedule: UnrefTimerSchedule = (callback) => {
    pending.push(callback);
    return () => {};
  };
  return { schedule, fire: async () => void (await pending.shift()?.()) };
}

test("a hold past the threshold reports the wait and what is behind it", async () => {
  const clock = manualClock();
  const { records } = await captureDaemonLogs(async () => {
    const watch = new RuntimeReadyWaitWatch({ heldCount: () => 3, schedule: clock.schedule });
    watch.begin("workspace-1");
    watch.attempt();
    await clock.fire();
  });
  const [waits] = records.filter((record) => record.properties.event === "runtime:ready_wait_long");
  expect(waits?.properties).toMatchObject({
    workspace_id: "workspace-1",
    held_control_count: 3,
    ready_attempts: 1,
    outcome: "waiting",
  });
  expect(Number(waits?.properties.waited_ms)).toBeGreaterThanOrEqual(0);
});

test("an outage of fast ready retries keeps one clock instead of restarting it", async () => {
  jest.useFakeTimers();
  const base = Date.parse("2026-01-01T00:00:00Z");
  setSystemTime(new Date(base));
  const clock = manualClock();
  const { records } = await captureDaemonLogs(async () => {
    const watch = new RuntimeReadyWaitWatch({ heldCount: () => 1, schedule: clock.schedule });
    // What task #687 looked like: each ready answered in seconds and was retried, again and again,
    // while the publications stayed held for hours. No single attempt can reach the threshold.
    watch.begin("workspace-1");
    watch.attempt();
    for (let retry = 1; retry < 40; retry += 1) {
      setSystemTime(new Date(base + retry * 3_000));
      watch.attempt();
    }
    await clock.fire();
  });
  const [waits] = records.filter((record) => record.properties.event === "runtime:ready_wait_long");
  expect(waits?.properties).toMatchObject({ ready_attempts: 40 });
  // The clock started at the first attempt and never restarted, so it covers the other thirty-nine.
  expect(waits?.properties.waited_ms).toBe(39 * 3_000);
});

test("a hold still not released repeats its report with the accumulated wait", async () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const clock = manualClock();
  const { records } = await captureDaemonLogs(async () => {
    const watch = new RuntimeReadyWaitWatch({ heldCount: () => 0, schedule: clock.schedule });
    watch.begin("workspace-1");
    await clock.fire();
    // Ten minutes later the hold is still there: the re-armed timer reports again.
    setSystemTime(new Date(Date.now() + 600_000));
    await clock.fire();
    watch.settle();
    // A timer that fires after the hold ended says nothing.
    await clock.fire();
  });
  const waits = records.filter((record) => record.properties.event === "runtime:ready_wait_long");
  expect(waits).toHaveLength(2);
  expect(waits[0]?.properties.waited_ms).toBe(0);
  expect(waits[1]?.properties.waited_ms).toBe(600_000);
});

test("a hold released before the threshold reports nothing", async () => {
  const clock = manualClock();
  const { records } = await captureDaemonLogs(async () => {
    const watch = new RuntimeReadyWaitWatch({ heldCount: () => 2, schedule: clock.schedule });
    watch.begin("workspace-1");
    watch.settle();
    await clock.fire();
  });
  expect(records.some((record) => record.properties.event === "runtime:ready_wait_long")).toBe(
    false,
  );
});
