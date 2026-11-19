import { describe, expect, test } from "bun:test";
import { utf8Encoder } from "@lrm/coforge-sdk/internal";
import { decodeUsageSnapshot } from "./usage-snapshot-decode.server";

describe("decodeUsageSnapshot quotaLevel", () => {
  test("preserves valid quotaLevel values and ignores unknown ones without rejecting the snapshot", () => {
    const encoded = utf8Encoder.encode(
      JSON.stringify({
        provider: "claude-code",
        primary: {
          status: "ok",
          quotaLevel: "near_exhausted",
          usedPercent: 92,
          windowDurationMinutes: 300,
          resetsAt: "2026-11-19T15:00:00.000Z",
        },
        secondary: {
          status: "ok",
          quotaLevel: "future_level",
          usedPercent: 40,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-11-26T15:00:00.000Z",
        },
      }),
    );

    const decoded = decodeUsageSnapshot(encoded, "claude-code");
    expect(decoded).toEqual({
      provider: "claude-code",
      primary: {
        status: "ok",
        quotaLevel: "near_exhausted",
        usedPercent: 92,
        windowDurationMinutes: 300,
        resetsAt: "2026-11-19T15:00:00.000Z",
      },
      secondary: {
        status: "ok",
        usedPercent: 40,
        windowDurationMinutes: 10_080,
        resetsAt: "2026-11-26T15:00:00.000Z",
      },
    });
  });
});
