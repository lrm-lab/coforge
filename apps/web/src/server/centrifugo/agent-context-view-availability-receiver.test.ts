import { expect, test } from "bun:test";
import { AgentContextViewAvailabilityStore } from "./agent-context-view-availability-receiver.server";

test("reads the provider availability reason instead of collapsing it to a boolean", async () => {
  const values = new Map<string, string>();
  const store = new AgentContextViewAvailabilityStore({
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  await store.record({
    type: "agent:context_view_availability",
    protocolMajor: 1,
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    runtime: "codex",
    supported: false,
    unsupportedReason: "no_session",
    retentionDays: 30,
    trigger: "startup",
  });
  await expect(store.read("w", "c", "a")).resolves.toEqual(
    expect.objectContaining({ supported: false, unsupportedReason: "no_session" }),
  );
});

test("treats missing and malformed availability as absent", async () => {
  const values = new Map<string, string>();
  const store = new AgentContextViewAvailabilityStore({
    get: async (key) => values.get(key) ?? null,
    set: async () => {},
  });
  await expect(store.read("w", "c", "missing")).resolves.toBeUndefined();
  await store.record({
    type: "agent:context_view_availability",
    protocolMajor: 1,
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    runtime: "codex",
    supported: true,
    retentionDays: 30,
  });
  const [key] = values.keys();
  values.set(key!, "not-json");
  await expect(store.read("w", "c", "a")).resolves.toBeUndefined();
});
