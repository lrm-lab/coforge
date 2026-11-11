import { describe, expect, test } from "bun:test";
import { offlineStart } from "#src/features/agents/agent-offline-start";
import type { AgentControlState } from "#src/features/agents/agent-control-realtime";

const pendingStart: AgentControlState = {
  agentId: "agent",
  requestId: "request",
  action: "start",
  phase: "pending",
  occurredAtMs: Date.now(),
};

describe("offlineStart (task #731)", () => {
  test("an offline Computer is named before Start is pressed", () => {
    const state = offlineStart({
      computerOnline: false,
      requested: false,
      computerLabel: "Studio",
    });
    expect(state).toMatchObject({ computerOffline: true, deferred: false, waiting: false });
    expect(String(state.note)).toBe("Computer offline");
  });

  test("a press says when the Agent will start", () => {
    const state = offlineStart({ computerOnline: false, requested: true, computerLabel: "Studio" });
    expect(state.deferred).toBe(true);
    expect(String(state.note)).toBe("Starts when Studio reconnects.");
  });

  test("a Start the server holds for the Computer is deferred, not running", () => {
    const state = offlineStart({
      computerOnline: false,
      control: pendingStart,
      requested: false,
      computerLabel: "Studio",
    });
    expect(state).toMatchObject({ waiting: true, deferred: true });
    expect(String(state.note)).toBe("Starts when Studio reconnects.");
  });

  test("a pending Stop is not a deferred Start", () => {
    const state = offlineStart({
      computerOnline: false,
      control: { ...pendingStart, action: "stop" },
      requested: false,
    });
    expect(state).toMatchObject({ waiting: false, deferred: false });
  });

  test("an online or unknown Computer adds nothing", () => {
    for (const computerOnline of [true, undefined]) {
      const state = offlineStart({ computerOnline, control: pendingStart, requested: true });
      expect(state).toMatchObject({ computerOffline: false, waiting: false, deferred: false });
      expect(state.note).toBeUndefined();
    }
  });

  test("a running Agent needs no Start note", () => {
    expect(offlineStart({ computerOnline: false, agentOnline: true, requested: false }).note).toBe(
      undefined,
    );
  });
});
