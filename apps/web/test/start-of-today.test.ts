import { afterEach, expect, jest, test } from "bun:test";

import { subscribeToMinutes } from "#src/lib/start-of-today";

/**
 * Task #361: a Chat row renders only for its own changes, so its "today" label (a clock time, not a
 * date) needs its own reason to render when the day turns. Every reader shares one minute timer.
 */
afterEach(() => jest.useRealTimers());

test("every reader hears each minute from one timer, which stops when the last one leaves", () => {
  jest.useFakeTimers();
  const heard: string[] = [];
  const stopFirst = subscribeToMinutes(() => heard.push("first"));
  const stopSecond = subscribeToMinutes(() => heard.push("second"));
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(60_000);
  expect(heard).toEqual(["first", "second"]);
  stopFirst();
  jest.advanceTimersByTime(60_000);
  expect(heard).toEqual(["first", "second", "second"]);
  stopSecond();
  expect(jest.getTimerCount()).toBe(0);
});
