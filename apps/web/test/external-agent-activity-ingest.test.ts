import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_ACTIVITY_SCHEMA,
  parseExternalActivityIngest,
} from "#src/server/agents/external-agent-activity-ingest.server";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const body = (events: unknown[], schema: unknown = EXTERNAL_ACTIVITY_SCHEMA) => ({
  schema,
  events,
});
const status = (overrides: Record<string, unknown> = {}) => ({
  eventId: "e1",
  occurredAt: "2026-11-18T09:59:00Z",
  status: "working",
  ...overrides,
});

function refusal(value: unknown) {
  const parsed = parseExternalActivityIngest(value, NOW);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.code;
}

function events(value: unknown) {
  const parsed = parseExternalActivityIngest(value, NOW);
  if (!parsed.ok) throw new Error(`refused: ${parsed.code}`);
  return parsed.events;
}

describe("external Agent activity ingest parsing", () => {
  test("refuses a body of another schema or with no event list", () => {
    expect(refusal(body([], "other.v1"))).toBe("invalid_request");
    expect(refusal(null)).toBe("invalid_request");
    expect(refusal({ schema: EXTERNAL_ACTIVITY_SCHEMA })).toBe("events_invalid");
    expect(refusal(body(Array.from({ length: 101 }, () => status())))).toBe("too_many_events");
  });

  test("an unknown status, a non-string detail or a long detail refuses the whole request", () => {
    expect(refusal(body([status(), status({ eventId: "e2", status: "busy" })]))).toBe(
      "status_invalid",
    );
    expect(refusal(body([status({ status: 3 })]))).toBe("status_invalid");
    expect(refusal(body([status({ detail: 5 })]))).toBe("detail_invalid");
    expect(refusal(body([status({ detail: "x".repeat(201) })]))).toBe("detail_too_long");
    expect(events(body([status({ detail: "x".repeat(200) })]))).toHaveLength(1);
  });

  test("a status event needs an event id and a time, or it is rejected alone", () => {
    const parsed = events(
      body([
        status(),
        status({ eventId: undefined }),
        status({ occurredAt: undefined }),
        status({ occurredAt: "yesterday" }),
      ]),
    );
    expect(parsed.map((event) => event.rejected)).toEqual([false, true, true, true]);
  });

  test("legacy outcomes are accepted and are not a status report", () => {
    for (const legacy of ["started", "succeeded", "failed", "completed"]) {
      const [event] = events(body([status({ status: legacy, hookEventName: "Stop" })]));
      expect(event?.rejected).toBe(false);
      expect(event?.report).toBeUndefined();
    }
  });

  test("a reported status carries its detail only for working and error", () => {
    const parsed = events(
      body([
        status({ detail: " building\n now " }),
        status({ eventId: "e2", status: "online", detail: "ignored" }),
        status({ eventId: "e3", status: "error", detail: "needs a key" }),
      ]),
    );
    expect(parsed.map((event) => event.report)).toEqual([
      { kind: "working", detail: "building now" },
      { kind: "online", detail: "" },
      { kind: "error", detail: "needs a key" },
    ]);
  });

  test("a future time counts as the receive time", () => {
    const [event] = events(body([status({ occurredAt: "2027-01-01T00:00:00Z" })]));
    expect(event?.occurredAtMs).toBe(NOW);
  });

  test("a hook event may carry no id or time and is dated by its receipt", () => {
    const [event] = events(body([{ hookEventName: "PreToolUse", toolName: "Bash" }]));
    expect(event?.rejected).toBe(false);
    expect(event?.occurredAtMs).toBe(NOW);
    expect(event?.eventId).toBeUndefined();
    expect(event?.hook).toEqual({ name: "PreToolUse", toolName: "Bash" });
  });

  test("a subagent marker needs a parent tool use id, or its event is rejected", () => {
    const parsed = events(
      body([
        status({
          subagent: { parentToolUseId: "tool-1", subagentType: "Explore", phase: "started" },
        }),
        status({ eventId: "e2", subagent: { subagentType: "Explore" } }),
      ]),
    );
    expect(parsed[0]?.subagent).toEqual({
      parentToolUseId: "tool-1",
      subagentType: "Explore",
      phase: "started",
    });
    expect(parsed[1]?.rejected).toBe(true);
  });

  test("a malformed hook field rejects its event only", () => {
    const parsed = events(
      body([
        { hookEventName: "PreToolUse", toolName: "Bash", toolInput: "x".repeat(300) },
        { hookEventName: 4 },
      ]),
    );
    expect(parsed.map((event) => event.rejected)).toEqual([true, true]);
  });
});
