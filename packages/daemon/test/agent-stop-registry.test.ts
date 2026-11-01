import { expect, test } from "bun:test";
import { AgentStopRegistry } from "#src/daemon-runtime/agent-stop-registry";

test("a stop forgets the Session its previous launch reported and marks the Agent stopping", () => {
  const registry = new AgentStopRegistry();
  registry.rememberSession("a", { requestId: "req-1", provider: "kiro", sessionId: "sess-1" });
  expect(registry.sessionId("a")).toBe("sess-1");

  registry.beginStop("a");
  expect(registry.stopping("a")).toBe(true);
  expect(registry.isStopping("a")).toBe(true);
  expect(registry.sessionReference("a")).toBeUndefined();
});

test("a stop in flight is joined, and settles only when its process is no longer stopping", () => {
  const registry = new AgentStopRegistry();
  const stop = Promise.withResolvers<void>();
  registry.beginStop("a");
  registry.trackStop("a", stop.promise);
  expect(registry.pendingStop("a")).toBe(stop.promise);
  expect(registry.isStopping("a")).toBe(true);

  // The process tree is still being torn down: the Agent stays marked stopping.
  registry.settleStop("a", true);
  expect(registry.pendingStop("a")).toBeUndefined();
  expect(registry.stopping("a")).toBe(true);

  registry.settleStop("a", false);
  expect(registry.stopping("a")).toBe(false);
  expect(registry.isStopping("a")).toBe(false);
});

test("a failed startup can mark its Agent stopping without a stop in flight", () => {
  const registry = new AgentStopRegistry();
  registry.beginStop("a");
  registry.forgetStopping("a");
  expect(registry.stopping("a")).toBe(false);
  expect(registry.pendingStop("a")).toBeUndefined();
});

test("a whole-runtime stop marks every Agent and clears every record", () => {
  const registry = new AgentStopRegistry();
  registry.rememberSession("a", { requestId: "req-1", provider: "kiro", sessionId: "sess-1" });
  registry.beginAll(["a", "b"]);
  expect([...registry.stoppingAgentIds()]).toEqual(["a", "b"]);

  registry.clear();
  expect(registry.stoppingAgentIds()).toEqual([]);
  expect(registry.sessionId("a")).toBeUndefined();
});
