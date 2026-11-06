import { expect, test } from "bun:test";

import { parseAgentDisplaySnapshot, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

const { agentStatusOnlySnapshot } = await import("#src/features/agents/agent-status-channel");
const { applyAgentDisplaySnapshot } = await import("#src/features/agents/agent-status-realtime");
const { dropStatusOnlyDisplay, mergeStatusOnlyDisplaySnapshot } =
  await import("#src/features/agents/agent-status-floor");

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 2,
    activityKind: "working",
    detailKind: "running_command",
    detail: "Running a tool",
    entries: [{ kind: "text", text: "hi" }],
    expiresAt: 50_000,
    ...overrides,
  };
}

// Task #587: a private Agent publishes a status floor (`statusOnly`) on the shared status
// channel so every member sees whether it is online, working or offline while its Activity
// stays private. The floor is a separate map, never a tracked Agent's `display`.
test("agentStatusOnlySnapshot keeps the status floor and drops every Activity word", () => {
  const full = display({
    detail: "Running a tool",
    detailKind: "running_command",
    entries: [{ kind: "text", text: "secret words" }],
    contextUsage: { usedTokens: 10, windowTokens: 100, observedAtMs: 1 },
    fastMode: { requested: true, observed: "on", observedAtMs: 1 },
    stopReason: "billing_exhausted",
  });
  const floor = agentStatusOnlySnapshot(full);
  expect(floor).toEqual({
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 2,
    activityKind: "working",
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 50_000,
    stopReason: "billing_exhausted",
    statusOnly: true,
  });
  expect(floor).not.toHaveProperty("contextUsage");
  expect(floor).not.toHaveProperty("fastMode");
  // The floor parses at the public boundary like any other snapshot.
  expect(parseAgentDisplaySnapshot(floor)).toEqual(floor);
});

test("a statusOnly snapshot parses only without Activity content", () => {
  const floor = {
    ...display(),
    detailKind: "",
    detail: "",
    entries: [],
    statusOnly: true as const,
  };
  expect(parseAgentDisplaySnapshot(floor).statusOnly).toBe(true);
  for (const invalid of [
    { ...floor, detail: "words" },
    { ...floor, detailKind: "running_command" },
    { ...floor, entries: [{ kind: "text", text: "hi" }] },
    { ...floor, contextUsage: { usedTokens: 1, windowTokens: 2, observedAtMs: 1 } },
    { ...floor, fastMode: { requested: true, observed: "on", observedAtMs: 1 } },
    { ...floor, statusOnly: false },
    { ...floor, statusOnly: "yes" },
  ]) {
    expect(() => parseAgentDisplaySnapshot(invalid)).toThrow();
  }
});

test("status floors keep the newest revision per Agent and a full display path ignores them", () => {
  const floor = (revision: number, activityKind: "working" | "online" = "working") =>
    agentStatusOnlySnapshot(display({ revision, activityKind }));
  const empty = new Map<string, AgentDisplaySnapshot>();
  const first = mergeStatusOnlyDisplaySnapshot(empty, floor(3));
  expect(first.get("agent-1")).toEqual(floor(3));
  // An older or equal revision never replaces; a newer one does.
  expect(mergeStatusOnlyDisplaySnapshot(first, floor(2))).toBe(first);
  expect(mergeStatusOnlyDisplaySnapshot(first, floor(3))).toBe(first);
  const newer = mergeStatusOnlyDisplaySnapshot(first, floor(4, "online"));
  expect(newer.get("agent-1")?.activityKind).toBe("online");
  // A floor can never become a tracked Agent's display, even at the same revision a full
  // snapshot would carry — the dedup the shared channel requires.
  const tracked = [
    {
      id: "agent-1",
      status: { value: "active" as const, expiresAt: null },
      computerId: "computer-1",
    },
  ];
  expect(applyAgentDisplaySnapshot(tracked, floor(3), "workspace-1")).toBe(tracked);
  // A full display drops the floor it supersedes.
  expect(dropStatusOnlyDisplay(newer, "agent-1").has("agent-1")).toBe(false);
  expect(dropStatusOnlyDisplay(newer, "nobody")).toBe(newer);
});
