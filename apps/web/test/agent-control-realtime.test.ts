import { expect, test } from "bun:test";
import {
  agentControlInFlight,
  agentControlPendingLabel,
  agentControlState,
  decodeAgentControlEvent,
  isAgentControlEvent,
  recordAgentControlEvent,
  subscribeAgentControl,
  type AgentControlRealtimeEvent,
} from "#src/features/agents/agent-control-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

const event: AgentControlRealtimeEvent = {
  type: REALTIME_EVENTS.agentControl,
  agentId: "agent-1",
  requestId: "req-1",
  action: "restart",
  phase: "pending",
  occurredAtMs: 1_000,
};

test("decodes a phase-only event and rejects malformed payloads", () => {
  expect(decodeAgentControlEvent(event)).toEqual(event);
  expect(isAgentControlEvent(event)).toBe(true);
  expect(isAgentControlEvent({ ...event, type: "other.v1" })).toBe(false);
  expect(() => decodeAgentControlEvent({ ...event, phase: "surprise" })).toThrow();
  expect(() => decodeAgentControlEvent({ ...event, action: "explode" })).toThrow();
  expect(() => decodeAgentControlEvent({ ...event, agentId: "" })).toThrow();
  expect(() =>
    decodeAgentControlEvent({ ...event, detail: "x".repeat(600), errorCode: "e" }),
  ).toThrow();
});

test("a phase-only event never erases the error fields of the same request", () => {
  recordAgentControlEvent({
    type: REALTIME_EVENTS.agentControl,
    agentId: "agent-merge",
    requestId: "req-1",
    action: "start",
    phase: "failed",
    errorCode: "launch_failed",
    detail: "provider refused",
    occurredAtMs: 2_000,
  });
  recordAgentControlEvent({
    ...event,
    agentId: "agent-merge",
    requestId: "req-1",
    action: "start",
    phase: "pending",
    occurredAtMs: 3_000,
  });
  const state = agentControlState("agent-merge");
  expect(state?.phase).toBe("pending");
  expect(state?.errorCode).toBe("launch_failed");
  expect(state?.detail).toBe("provider refused");
});

test("in-flight phases report busy and pending labels; settled phases do not", () => {
  expect(agentControlInFlight(agentControlState("agent-merge"))).toBe(true);
  expect(agentControlPendingLabel(agentControlState("agent-merge"))).toBeTruthy();
  recordAgentControlEvent({
    type: REALTIME_EVENTS.agentControl,
    agentId: "agent-merge",
    requestId: "req-1",
    action: "start",
    phase: "completed",
    occurredAtMs: 4_000,
  });
  expect(agentControlInFlight(agentControlState("agent-merge"))).toBe(false);
  expect(agentControlPendingLabel(agentControlState("agent-merge"))).toBeUndefined();
});

test("subscribers hear each recorded event for their Agent only", () => {
  let heard = 0;
  const unsubscribe = subscribeAgentControl("agent-listen", () => heard++);
  recordAgentControlEvent({
    type: REALTIME_EVENTS.agentControl,
    agentId: "agent-other",
    requestId: "req-9",
    action: "stop",
    phase: "accepted",
    occurredAtMs: 5_000,
  });
  expect(heard).toBe(0);
  recordAgentControlEvent({
    type: REALTIME_EVENTS.agentControl,
    agentId: "agent-listen",
    requestId: "req-9",
    action: "stop",
    phase: "accepted",
    occurredAtMs: 6_000,
  });
  expect(heard).toBe(1);
  unsubscribe();
  recordAgentControlEvent({
    type: REALTIME_EVENTS.agentControl,
    agentId: "agent-listen",
    requestId: "req-9",
    action: "stop",
    phase: "completed",
    occurredAtMs: 7_000,
  });
  expect(heard).toBe(1);
});
