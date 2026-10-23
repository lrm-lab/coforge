import { describe, expect, test } from "bun:test";
import { markStartup, startupTiming } from "#src/platform/startup-timing";

describe("startupTiming", () => {
  test("reports the process start and every startup mark in ms since it", () => {
    performance.mark("coforge:startup:main");
    markStartup("logging");
    performance.mark("unrelated");
    const fields = startupTiming();
    expect(fields.process_started_at).toBe(new Date(performance.timeOrigin).toISOString());
    expect(fields.startup_main_ms).toBeNumber();
    expect(fields.startup_logging_ms).toBeGreaterThanOrEqual(fields.startup_main_ms as number);
    expect(fields.startup_ms).toBeGreaterThanOrEqual(fields.startup_logging_ms as number);
    expect(Object.keys(fields).some((key) => key.includes("unrelated"))).toBe(false);
  });
});
