import { expect, test } from "bun:test";

import { parseAgentDisplaySnapshot, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

const { agentStatusOnlySnapshot } = await import("#src/features/agents/agent-status-channel");
const { applyAgentDisplaySnapshot } = await import("#src/features/agents/agent-status-realtime");
const {
  dropStatusOnlyDisplay,
  mergeStatusOnlyDisplaySnapshot,
  selectDisplayOnline,
  selectDisplayProfileMetrics,
  selectHasLiveRosterAgent,
  selectLiveAgentIdentity,
} = await import("#src/features/agents/agent-status-floor");

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
    stopDetail: "the provider's words",
    stopMessage:
      "Pi's model provider rejected the API key, or no key is set for it on this machine.",
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
  // The Daemon's sentence names the model and provider a private Agent's owner chose (task #682).
  expect(floor).not.toHaveProperty("stopMessage");
  expect(() =>
    parseAgentDisplaySnapshot({ ...floor, stopMessage: "Pi's model provider rejected the key." }),
  ).toThrow();
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

test("an external Agent's last-seen time rides the floor and is validated at the boundary", () => {
  const external = display({
    computerId: "",
    activityKind: "offline",
    expiresAt: null,
    detailKind: "",
    detail: "",
    entries: [],
    lastSeenAtMs: 1_700_000_000_000,
  });
  expect(parseAgentDisplaySnapshot(external).lastSeenAtMs).toBe(1_700_000_000_000);
  const floor = agentStatusOnlySnapshot(external);
  expect(floor.lastSeenAtMs).toBe(1_700_000_000_000);
  expect(parseAgentDisplaySnapshot(floor)).toEqual(floor);
  expect(parseAgentDisplaySnapshot({ ...external, lastSeenAtMs: null }).lastSeenAtMs).toBeNull();
  expect(parseAgentDisplaySnapshot(display())).not.toHaveProperty("lastSeenAtMs");
  for (const lastSeenAtMs of [0, -1, 1.5, "1700000000000", Number.NaN])
    expect(() => parseAgentDisplaySnapshot({ ...external, lastSeenAtMs })).toThrow();
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
  expect(dropStatusOnlyDisplay(newer, "agent-1").has("agent-1")).toBe(false);
  expect(dropStatusOnlyDisplay(newer, "nobody")).toBe(newer);
});

test("live store selectors isolate roster presence, static identity, online state, and profile metrics", () => {
  const agents = [
    { id: "a1", displayName: "Atlas", avatarUrl: null, mascot: "blue" as const },
    { id: "a2", displayName: "Extra", isExtra: true as const },
  ];
  expect(selectHasLiveRosterAgent(agents, "a1")).toBe(true);
  expect(selectHasLiveRosterAgent(agents, "a2")).toBe(false);
  expect(selectHasLiveRosterAgent(agents, "missing")).toBe(false);
  expect(selectHasLiveRosterAgent(agents, null)).toBe(false);

  expect(selectLiveAgentIdentity(agents, "a1")).toEqual({
    displayName: "Atlas",
    avatarUrl: null,
    mascot: "blue",
  });
  expect(selectLiveAgentIdentity(agents, "missing")).toBeUndefined();

  expect(selectDisplayOnline(undefined, false)).toBeUndefined();
  expect(selectDisplayOnline(undefined, true)).toBe(false);
  expect(selectDisplayOnline(display({ activityKind: "offline" }), false)).toBe(false);
  expect(selectDisplayOnline(display({ activityKind: "working" }), true)).toBe(true);

  const metrics = selectDisplayProfileMetrics(
    display({
      contextUsage: { usedTokens: 100, windowTokens: 1000, observedAtMs: 5 },
      fastMode: { requested: true, observed: "on", observedAtMs: 6 },
    }),
  );
  expect(metrics).toEqual({
    contextUsage: { usedTokens: 100, windowTokens: 1000, observedAtMs: 5 },
    fastMode: { requested: true, observed: "on", observedAtMs: 6 },
  });
  expect(selectDisplayProfileMetrics(undefined)).toEqual({ contextUsage: null, fastMode: null });
});

test("primitive busy-count, working-ids, and avatar-view selectors stay stable across unchanged heartbeats", async () => {
  const {
    sameOptionalAgentAvatarView,
    selectAgentAvatarView,
    selectBusyAgentCount,
    selectWorkingAgentIds,
  } = await import("#src/features/agents/agent-status-floor");

  const snap1 = display({
    agentId: "a1",
    revision: 1,
    activityKind: "working",
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 10_000,
  });
  const snap2 = display({
    agentId: "a1",
    revision: 2,
    activityKind: "working",
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 20_000,
    contextUsage: { usedTokens: 500, windowTokens: 1000, observedAtMs: 20_000 },
  });
  const idle = display({ agentId: "a2", revision: 1, activityKind: "online" });
  const thinking = display({ agentId: "a3", revision: 1, activityKind: "thinking" });

  const list1 = [
    { id: "a1", display: snap1 },
    { id: "a2", display: idle },
    { id: "a3", display: thinking },
  ];
  const list2 = [
    { id: "a1", display: snap2 },
    { id: "a2", display: idle },
    { id: "a3", display: thinking },
  ];

  expect(selectBusyAgentCount(list1)).toBe(2);
  expect(selectBusyAgentCount(list2)).toBe(2);
  const channelMembers = new Set(["a1", "a2"]);
  expect(selectWorkingAgentIds(list1, channelMembers)).toBe("a1");
  expect(selectWorkingAgentIds(list2, channelMembers)).toBe("a1");

  const view1 = selectAgentAvatarView(snap1);
  const view2 = selectAgentAvatarView(snap2);
  const viewIdle = selectAgentAvatarView(idle);
  expect(sameOptionalAgentAvatarView(view1, view2)).toBe(true);
  expect(sameOptionalAgentAvatarView(view1, viewIdle)).toBe(false);
  expect(sameOptionalAgentAvatarView(undefined, undefined)).toBe(true);
  expect(sameOptionalAgentAvatarView(view1, undefined)).toBe(false);
});

test("runtime-provider-label exposes provider labels without pulling SVG assets", async () => {
  const { runtimeProviderDisplayName, runtimeProviderLabel } =
    await import("#src/features/agents/runtime-provider-label");
  expect(runtimeProviderLabel("codex")).toBe("Codex");
  expect(runtimeProviderDisplayName("claude-code")).toBe("Claude Code");
  expect(runtimeProviderDisplayName("custom")).toBe("custom");
});
