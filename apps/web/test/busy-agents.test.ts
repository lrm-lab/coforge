import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { pickBusyAgents, rankBusyAgents } from "#src/features/agents/busy-agents";
import { defaultAgentMascot, type AgentMascot } from "#src/features/agents/agent-mascot";

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 1,
    activityKind: "working",
    detailKind: "tool_start",
    detail: "Running command…",
    entries: [],
    expiresAt: 99_000,
    ...overrides,
  };
}

type TestAgent = {
  id: string;
  name: string;
  displayName: string;
  mascot?: AgentMascot;
  display?: AgentDisplaySnapshot;
  isExtra?: true;
};

function agent(id: string, displayName: string, snapshot?: AgentDisplaySnapshot): TestAgent {
  return { id, name: id, displayName, display: snapshot };
}

/** What the header ranks: the Agents `pickBusyAgents` found busy. */
const rank = (agents: TestAgent[], directAgentIds: ReadonlySet<string> = NO_DIRECTS) =>
  rankBusyAgents(pickBusyAgents(agents), directAgentIds);

const NO_DIRECTS = new Set<string>();

test("only Agents working or thinking right now are busy, and they are the same objects", () => {
  const atlas = agent("atlas", "Atlas", display());
  const sam = agent("sam", "Sam", display({ activityKind: "thinking", detail: "" }));
  const agents = [
    atlas,
    sam,
    agent("idle", "Idle", display({ activityKind: "online", detail: "" })),
    agent("off", "Off", display({ activityKind: "offline", detail: "" })),
    agent("err", "Err", display({ activityKind: "error", detail: "boom" })),
    agent("unknown", "Unknown"),
  ];
  const busy = pickBusyAgents(agents);
  expect(busy).toHaveLength(2);
  expect(Object.is(busy[0], atlas)).toBe(true);
  expect(Object.is(busy[1], sam)).toBe(true);
});

test("a busy Agent carries its current label in sentence form, its mascot and what it acts out", () => {
  const withMascot: TestAgent = { ...agent("a", "A", display()), mascot: "pink" };
  const thinking = agent("b", "B", display({ activityKind: "thinking", detail: "" }));
  const [own, fallback] = rank([withMascot, thinking]);
  expect([own!.label, own!.mascot, own!.activity]).toEqual(["running command", "pink", "working"]);
  expect([fallback!.label, fallback!.mascot, fallback!.activity]).toEqual([
    "thinking",
    defaultAgentMascot("b"),
    "thinking",
  ]);
});

test("Agents the viewer has a direct conversation with come first, then everyone by name", () => {
  const agents = [
    agent("1", "Zed", display()),
    agent("2", "atlas", display()),
    agent("3", "Mia", display()),
    agent("4", "Bea", display()),
  ];
  const directs = new Set(["1", "3"]);
  expect(rank(agents, directs).map((entry) => entry.name)).toEqual(["Mia", "Zed", "atlas", "Bea"]);
  expect(rank([...agents].reverse(), directs).map((entry) => entry.name)).toEqual([
    "Mia",
    "Zed",
    "atlas",
    "Bea",
  ]);
});

test("a blank display name reads as the Agent's name", () => {
  const [entry] = rank([agent("atlas", "  ", display())]);
  expect(entry!.name).toBe("atlas");
});

test("the viewer's own Agents come before the Workspace's others, after the direct conversations", () => {
  const others = (id: string, displayName: string) => ({
    ...agent(id, displayName, display()),
    isExtra: true as const,
  });
  const agents = [
    others("1", "Ann"),
    agent("2", "Zed", display()),
    others("3", "Bea"),
    agent("4", "Mia", display()),
    others("5", "Cy"),
  ];
  const order = (list: typeof agents, directs: ReadonlySet<string>) =>
    rankBusyAgents(pickBusyAgents(list), directs).map((entry) => entry.name);
  expect(order(agents, NO_DIRECTS)).toEqual(["Mia", "Zed", "Ann", "Bea", "Cy"]);
  // An open conversation outranks ownership, whoever the Agent belongs to.
  expect(order(agents, new Set(["5"]))).toEqual(["Cy", "Mia", "Zed", "Ann", "Bea"]);
  expect(order([...agents].reverse(), new Set(["5"]))).toEqual(["Cy", "Mia", "Zed", "Ann", "Bea"]);
});
