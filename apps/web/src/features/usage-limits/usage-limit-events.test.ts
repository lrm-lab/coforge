import { describe, expect, test } from "bun:test";

import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { decodeUsageLimitChangedEvent } from "./usage-limit-events";

describe("decodeUsageLimitChangedEvent", () => {
  test("decodes an open change with its set size and reset", () => {
    expect(
      decodeUsageLimitChangedEvent({
        type: REALTIME_EVENTS.usageLimitChanged,
        workspaceId: "ws",
        eventId: "event",
        status: "open",
        affectedCount: 2,
        resetsAt: "2026-11-07T00:00:00.000Z",
      }),
    ).toEqual({
      type: "usage.limit.changed.v1",
      workspaceId: "ws",
      eventId: "event",
      status: "open",
      affectedCount: 2,
      resetsAt: "2026-11-07T00:00:00.000Z",
    });
  });

  test("decodes a close with its reason and no reset", () => {
    expect(
      decodeUsageLimitChangedEvent({
        type: REALTIME_EVENTS.usageLimitChanged,
        workspaceId: "ws",
        eventId: "event",
        status: "closed",
        closeReason: "reset_passed",
        affectedCount: 0,
        resetsAt: null,
      }),
    ).toMatchObject({ status: "closed", closeReason: "reset_passed" });
  });

  test("rejects a foreign type, an unknown close reason, and missing state", () => {
    expect(
      decodeUsageLimitChangedEvent({
        type: "task.changed.v1",
        workspaceId: "ws",
        eventId: "event",
        status: "open",
        affectedCount: 1,
        resetsAt: null,
      }),
    ).toBeUndefined();
    expect(
      decodeUsageLimitChangedEvent({
        type: REALTIME_EVENTS.usageLimitChanged,
        workspaceId: "ws",
        eventId: "event",
        status: "closed",
        closeReason: "vibes",
        affectedCount: 0,
        resetsAt: null,
      }),
    ).toBeUndefined();
    expect(
      decodeUsageLimitChangedEvent({
        type: REALTIME_EVENTS.usageLimitChanged,
        workspaceId: "ws",
        eventId: "event",
        status: "open",
      }),
    ).toBeUndefined();
  });
});
