import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { defaultAgentMascot } from "#src/features/agents/agent-mascot";
import { activitySentenceLabel } from "#src/features/agents/agent-activity-presentation";
import {
  busyAgentsAmong,
  summarizeBusyAgents,
  type BusyAgent,
  type SummaryPart,
} from "#src/features/agents/busy-agents-summary";

// en-GB lists "A, B and C"; en-US would add the serial comma.
const ENGLISH = { locale: "en-GB", others: (count: number) => `${count} others` };

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

function agent(id: string, displayName: string, snapshot?: AgentDisplaySnapshot) {
  return { id, name: id, displayName, mascot: undefined, display: snapshot };
}

function busy(name: string, label: string): BusyAgent {
  return { id: name.toLowerCase(), name, mascot: "blue", activity: "working", label };
}

const sentence = (parts: readonly SummaryPart[]) => parts.map((part) => part.text).join("");

test("only member Agents that are working or thinking count as busy, whatever they are busy for", () => {
  const agents = [
    agent("atlas", "Atlas", display()),
    agent("sam", "Sam", display({ activityKind: "thinking", detail: "" })),
    agent("idle", "Idle", display({ activityKind: "online", detail: "" })),
    agent("off", "Off", display({ activityKind: "offline", detail: "" })),
    agent("err", "Err", display({ activityKind: "error", detail: "boom" })),
    agent("unknown", "Unknown"),
    agent("stranger", "Stranger", display()),
  ];
  const members = ["atlas", "sam", "idle", "off", "err", "unknown"];
  expect(busyAgentsAmong(agents, members).map((entry) => [entry.name, entry.label])).toEqual([
    ["Atlas", "running command"],
    ["Sam", "thinking"],
  ]);
});

test("a busy Agent with a blank display name reads by its name", () => {
  const [entry] = busyAgentsAmong([agent("atlas", "  ", display())], ["atlas"]);
  expect(entry!.name).toBe("atlas");
});

test("a busy Agent carries its mascot, else its id's, and acts out its work", () => {
  const withMascot = { ...agent("a", "A", display()), mascot: "pink" as const };
  const thinking = agent("b", "B", display({ activityKind: "thinking", detail: "" }));
  const [own, fallback] = busyAgentsAmong([withMascot, thinking], ["a", "b"]);
  expect([own!.mascot, own!.activity]).toEqual(["pink", "working"]);
  expect([fallback!.mascot, fallback!.activity]).toEqual([defaultAgentMascot("b"), "thinking"]);
});

test("busy Agents come in a stable order by name, not by the roster order", () => {
  const first = [agent("2", "Sam", display()), agent("1", "atlas", display())];
  const second = [...first].reverse();
  const names = (agents: typeof first) =>
    busyAgentsAmong(agents, ["1", "2"]).map((entry) => entry.name);
  expect(names(first)).toEqual(["atlas", "Sam"]);
  expect(names(second)).toEqual(["atlas", "Sam"]);
});

test("nobody busy gives no sentence", () => {
  expect(summarizeBusyAgents([], ENGLISH)).toEqual([]);
});

test("one busy Agent reads as its name then its lowercased label", () => {
  const parts = summarizeBusyAgents([busy("Atlas", "running command")], ENGLISH);
  expect(sentence(parts)).toBe("Atlas running command");
  expect(parts.filter((part) => part.kind === "name").map((part) => part.text)).toEqual(["Atlas"]);
});

test("Agents sharing a label are joined as A and B, or A, B and C", () => {
  expect(
    sentence(
      summarizeBusyAgents(
        [busy("Atlas", "running command"), busy("Develop Agent", "running command")],
        ENGLISH,
      ),
    ),
  ).toBe("Atlas and Develop Agent running command");
  expect(
    sentence(
      summarizeBusyAgents(
        [busy("A", "thinking"), busy("B", "thinking"), busy("C", "thinking")],
        ENGLISH,
      ),
    ),
  ).toBe("A, B and C thinking");
});

test("different labels make groups separated by a middle dot, in order of first appearance", () => {
  expect(
    sentence(
      summarizeBusyAgents(
        [
          busy("Atlas", "running command"),
          busy("Sam", "thinking"),
          busy("Develop Agent", "running command"),
        ],
        ENGLISH,
      ),
    ),
  ).toBe("Atlas and Develop Agent running command · Sam thinking");
});

test("more than three names in a group shows two and counts the rest", () => {
  const four = ["A", "B", "C", "D"].map((name) => busy(name, "thinking"));
  expect(sentence(summarizeBusyAgents(four, ENGLISH))).toBe("A, B and 2 others thinking");
  const six = ["A", "B", "C", "D", "E", "F"].map((name) => busy(name, "thinking"));
  expect(sentence(summarizeBusyAgents(six, ENGLISH))).toBe("A, B and 4 others thinking");
});

test("names carry the name weight and the joiners and label do not", () => {
  const parts = summarizeBusyAgents(
    [busy("Atlas", "running command"), busy("Sam", "running command")],
    ENGLISH,
  );
  expect(parts).toEqual([
    { kind: "name", text: "Atlas" },
    { kind: "text", text: " and " },
    { kind: "name", text: "Sam" },
    { kind: "text", text: " running command" },
  ]);
});

test("the overflow count is plain text, never a name", () => {
  const four = ["A", "B", "C", "D"].map((name) => busy(name, "thinking"));
  expect(summarizeBusyAgents(four, ENGLISH)).toEqual([
    { kind: "name", text: "A" },
    { kind: "text", text: ", " },
    { kind: "name", text: "B" },
    { kind: "text", text: " and " },
    { kind: "text", text: "2 others" },
    { kind: "text", text: " thinking" },
  ]);
});

test("the list follows the locale's own joiners", () => {
  const three = ["A", "B", "C"].map((name) => busy(name, "thinking"));
  const chinese = { locale: "zh-CN", others: (count: number) => `其他 ${count} 个` };
  expect(sentence(summarizeBusyAgents(three, chinese))).toBe("A、B和C thinking");
});

test("a label reads in a sentence without its ellipsis and keeps an acronym's capitals", () => {
  expect(activitySentenceLabel("Running command…")).toBe("running command");
  expect(activitySentenceLabel("Thinking...")).toBe("thinking");
  expect(activitySentenceLabel("MCP call...")).toBe("MCP call");
  expect(activitySentenceLabel("Subagent working…")).toBe("subagent working");
});
