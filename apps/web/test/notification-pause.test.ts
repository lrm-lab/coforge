import { describe, expect, test } from "bun:test";
import {
  customPauseEnd,
  localInputValue,
  pauseEnd,
} from "#src/features/notifications/notification-pause";

const now = new Date(2026, 10, 5, 14, 20);

describe("notification pauses (task #469)", () => {
  test("a span runs from now; tomorrow ends at 9:00 on this computer's clock", () => {
    expect(pauseEnd("30m", now)).toEqual(new Date(2026, 10, 5, 14, 50));
    expect(pauseEnd("2h", now)).toEqual(new Date(2026, 10, 5, 16, 20));
    expect(pauseEnd("tomorrow", now)).toEqual(new Date(2026, 10, 6, 9, 0));
  });

  test("a custom pause names a time after now and within a year", () => {
    expect(customPauseEnd("2026-11-07T18:00", now)).toEqual(new Date(2026, 10, 7, 18, 0));
    expect(customPauseEnd("2026-11-05T14:20", now)).toBeNull();
    expect(customPauseEnd("2026-11-01T09:00", now)).toBeNull();
    expect(customPauseEnd("2028-01-01T09:00", now)).toBeNull();
    expect(customPauseEnd("", now)).toBeNull();
    expect(customPauseEnd("next week", now)).toBeNull();
  });

  test("the input's value is the local time to the minute", () => {
    expect(localInputValue(new Date(2026, 0, 2, 3, 4, 59))).toBe("2026-01-02T03:04");
    expect(customPauseEnd(localInputValue(pauseEnd("2h", now)), now)).toEqual(
      new Date(2026, 10, 5, 16, 20),
    );
  });
});
