import { expect, test } from "bun:test";
import { createStore } from "@tanstack/react-store";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { agentById } from "#src/features/agents/agent-status-floor";
import {
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  expireAgentStatuses,
  type AgentStatusView,
} from "#src/features/agents/agent-status-realtime";
import {
  resolveAgentDisplay,
  selectExtraWatchId,
  selectLiveAgentDisplay,
} from "#src/features/agents/workspace-agents-realtime";

type Agent = {
  id: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  isExtra?: true;
};

const display = (
  agentId: string,
  revision: number,
  overrides: Partial<AgentDisplaySnapshot> = {},
): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
  revision,
  activityKind: "working",
  detailKind: "running_command",
  detail: "Running command",
  entries: [{ kind: "tool_start", toolName: "shell" }],
  expiresAt: 50_000,
  ...overrides,
});

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id,
  status: {
    value: "active",
    expiresAt: 90_000,
    ordering: { daemonInstanceId: "daemon-1", clientSeq: 1, observedAtMs: 1_000 },
  },
  display: display(id, 1),
  ...overrides,
});

function watch(
  store: ReturnType<typeof createStore<Agent[]>>,
  agentId: string,
  floors: ReadonlyMap<string, AgentDisplaySnapshot> = new Map(),
) {
  const told = { count: 0 };
  const subscription = createStore(() =>
    resolveAgentDisplay(selectLiveAgentDisplay(store.state, agentId), floors.get(agentId)),
  ).subscribe(() => {
    told.count++;
  });
  return { told, stop: () => subscription.unsubscribe() };
}

test("resolves own Agents, other members' isExtra Agents, and status floors through the shared selectors", () => {
  const floor = display("private-member", 1, {
    activityKind: "online",
    detailKind: "",
    detail: "",
    entries: [],
    statusOnly: true,
  });
  const extraFull = display("extra", 2, { activityKind: "online" });
  const extraFloor = display("extra", 2, {
    activityKind: "offline",
    detailKind: "",
    detail: "",
    entries: [],
    statusOnly: true,
  });
  const agents = [
    agent("own"),
    agent("extra", { isExtra: true, display: extraFull }),
    agent("extra-unknown", { isExtra: true, display: undefined }),
  ];
  const floors = new Map<string, AgentDisplaySnapshot>([
    ["private-member", floor],
    ["extra", extraFloor],
  ]);

  const read = (id: string) =>
    resolveAgentDisplay(selectLiveAgentDisplay(agents, id), id ? floors.get(id) : undefined);

  expect(read("own")?.agentId).toBe("own");
  expect(read("extra")).toBe(extraFull);
  expect(read("private-member")).toBe(floor);
  expect(read("extra-unknown")).toBeUndefined();
  expect(read("gone")).toBeUndefined();
  expect(read("")).toBeUndefined();

  expect(selectExtraWatchId(agents, "own")).toBe("");
  expect(selectExtraWatchId(agents, "extra")).toBe("extra");
  expect(selectExtraWatchId(agents, "extra-unknown")).toBe("extra-unknown");
  expect(selectExtraWatchId(agents, "private-member")).toBe("");
  expect(selectExtraWatchId(agents, "")).toBe("");
});

test("one Agent's new activity notifies only its own selector, leaving unrelated rows stable", () => {
  const store = createStore([agent("own"), agent("extra", { isExtra: true })]);
  const own = watch(store, "own");
  const extra = watch(store, "extra");
  try {
    store.setState((agents) => applyAgentDisplaySnapshot(agents, display("own", 2)));
    expect(own.told.count).toBe(1);
    expect(extra.told.count).toBe(0);

    store.setState((agents) => applyAgentDisplaySnapshot(agents, display("extra", 2)));
    expect(own.told.count).toBe(1);
    expect(extra.told.count).toBe(1);
  } finally {
    own.stop();
    extra.stop();
  }
});

test("a status lease refresh keeps every Agent's display without repainting", () => {
  const store = createStore([agent("a"), agent("b", { isExtra: true })]);
  const a = watch(store, "a");
  const b = watch(store, "b");
  try {
    store.setState((agents) =>
      applyAgentStatusEvent(agents, {
        agentId: "a",
        status: "active",
        expiresAt: 120_000,
        daemonInstanceId: "daemon-1",
        clientSeq: 2,
        observedAtMs: 2_000,
      }),
    );
    expect(a.told.count).toBe(0);
    expect(b.told.count).toBe(0);
  } finally {
    a.stop();
    b.stop();
  }
});

test("expireAgentStatuses keeps the same array reference when no Agent expires", () => {
  const list = [agent("a"), agent("b", { status: { value: "inactive", expiresAt: null } })];
  expect(expireAgentStatuses(list, 10_000)).toBe(list);
  const expired = expireAgentStatuses(list, 95_000);
  expect(expired).not.toBe(list);
  expect(expired[0]?.status.value).toBe("inactive");
  expect(expired[1]).toBe(list[1]);
});

test("agentById resolves entries from the current array snapshot and reflects replacements", () => {
  const first = [agent("a"), agent("b")];
  expect(agentById(first, "a")).toBe(first[0]);
  expect(agentById(first, "b")).toBe(first[1]);
  expect(agentById(first, "missing")).toBeUndefined();
  expect(agentById(first, "")).toBeUndefined();

  const updated = applyAgentDisplaySnapshot(first, display("a", 2));
  expect(agentById(updated, "a")?.display?.revision).toBe(2);
  expect(agentById(first, "a")?.display?.revision).toBe(1);
});
