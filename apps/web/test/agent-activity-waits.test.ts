import { describe, expect, test } from "bun:test";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { computeModelResponseWaits } from "#src/features/agents/agent-activity-waits";

const WAIT_DETAIL = "Waiting for model response";

describe("computeModelResponseWaits", () => {
  test("computes endedAtMs from the closest newer qualifying event in the same launch", () => {
    const activity = [
      {
        launchId: "launch-1",
        clientSeq: 5,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
        detail: "Running tool",
        observedAtMs: 5_000,
      },
      {
        launchId: "launch-1",
        clientSeq: 4,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
        detail: "Tool finished",
        observedAtMs: 4_000,
      },
      {
        launchId: "launch-1",
        clientSeq: 3,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
        detail: WAIT_DETAIL,
        observedAtMs: 3_000,
      },
      {
        launchId: "launch-1",
        clientSeq: 2,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
        detail: "Message received",
        observedAtMs: 2_000,
      },
      {
        launchId: "launch-1",
        clientSeq: 1,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
        detail: WAIT_DETAIL,
        observedAtMs: 1_000,
      },
    ];

    const waits = computeModelResponseWaits(activity);
    expect(waits.get("launch-1:3:0")).toEqual({
      startedAtMs: 3_000,
      endedAtMs: 5_000,
      isHead: false,
    });
    expect(waits.get("launch-1:1:0")).toEqual({
      startedAtMs: 1_000,
      endedAtMs: 3_000,
      isHead: false,
    });
    expect(waits.size).toBe(2);
  });

  test("marks index 0 wait as head with undefined endedAtMs and isolates launches", () => {
    const activity = [
      {
        launchId: "launch-b",
        clientSeq: 2,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
        detail: WAIT_DETAIL,
        observedAtMs: 9_000,
      },
      {
        launchId: "launch-a",
        clientSeq: 1,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
        detail: WAIT_DETAIL,
        observedAtMs: 6_000,
      },
    ];

    const waits = computeModelResponseWaits(activity);
    expect(waits.get("launch-b:2:0")).toEqual({
      startedAtMs: 9_000,
      endedAtMs: undefined,
      isHead: true,
    });
    expect(waits.get("launch-a:1:0")).toEqual({
      startedAtMs: 6_000,
      endedAtMs: undefined,
      isHead: false,
    });
  });

  test("ignores model_request_started entries with non-wait detail text", () => {
    const activity = [
      {
        launchId: "launch-1",
        clientSeq: 2,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
        detail: "Tool",
        observedAtMs: 2_000,
      },
      {
        launchId: "launch-1",
        clientSeq: 1,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
        detail: "Different detail",
        observedAtMs: 1_000,
      },
    ];

    expect(computeModelResponseWaits(activity).size).toBe(0);
  });

  test("matches reference scan over a 500-entry multi-launch feed", () => {
    const kinds = [
      AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
      AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
      AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
      AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
    ] as const;
    const activity = Array.from({ length: 500 }, (_, index) => {
      const detailKind = kinds[index % kinds.length]!;
      return {
        launchId: `launch-${index % 3}`,
        clientSeq: 500 - index,
        detailKind,
        detail:
          detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED ? WAIT_DETAIL : "event",
        observedAtMs: (500 - index) * 100,
      };
    });

    const waits = computeModelResponseWaits(activity);
    for (let index = 0; index < activity.length; index += 1) {
      const entry = activity[index]!;
      const key = `${entry.launchId}:${entry.clientSeq}:0`;
      if (
        entry.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED ||
        entry.detail !== WAIT_DETAIL
      ) {
        expect(waits.has(key)).toBe(false);
        continue;
      }
      const expectedNext = activity
        .slice(0, index)
        .reverse()
        .find(
          (candidate) =>
            candidate.launchId === entry.launchId &&
            candidate.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED &&
            candidate.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
        );
      expect(waits.get(key)).toEqual({
        startedAtMs: entry.observedAtMs,
        endedAtMs: expectedNext?.observedAtMs,
        isHead: index === 0,
      });
    }
  });
});
