import { afterEach, expect, jest, test } from "bun:test";
import {
  IMPORTANT_UNREAD_SWEEP_MS,
  ImportantUnreadSweep,
} from "#src/daemon-runtime/important-unread-sweep";
import { RuntimeSweeps } from "#src/daemon-runtime/runtime-sweeps";

afterEach(() => jest.useRealTimers());

test("the unread sweep runs again after the runtime stops and starts again", () => {
  jest.useFakeTimers();
  let flushes = 0;
  const sweeps = new RuntimeSweeps([]);
  sweeps.add(new ImportantUnreadSweep({ flushDue: () => ++flushes }));
  jest.advanceTimersByTime(IMPORTANT_UNREAD_SWEEP_MS);
  expect(flushes).toBe(0);
  sweeps.start();
  jest.advanceTimersByTime(IMPORTANT_UNREAD_SWEEP_MS);
  expect(flushes).toBe(1);
  sweeps.stop();
  jest.advanceTimersByTime(IMPORTANT_UNREAD_SWEEP_MS * 3);
  expect(flushes).toBe(1);
  sweeps.start();
  jest.advanceTimersByTime(IMPORTANT_UNREAD_SWEEP_MS);
  expect(flushes).toBe(2);
});
