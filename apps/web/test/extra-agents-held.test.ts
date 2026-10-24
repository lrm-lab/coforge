import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { HELD_AGENT_IDS_LIMIT } from "#src/features/agents/extra-agent";
import { createDisplayWatchRegistry } from "#src/features/agents/watched-agent-displays";
import { heldDisplayAgentIds } from "#src/features/agents/extra-agents-held";

const display = (
  activityKind: AgentDisplaySnapshot["activityKind"],
  expiresAt: number | null = null,
): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  revision: 1,
  activityKind,
  detailKind: "",
  detail: "",
  entries: [],
  expiresAt,
});

const agent = (id: string, held?: AgentDisplaySnapshot, isExtra = true) => ({
  id,
  display: held,
  ...(isExtra ? { isExtra: true as const } : {}),
});

test("holds the extras shown busy, and the ones whose display has lapsed", () => {
  const now = 10_000;
  expect(
    heldDisplayAgentIds(
      [
        agent("working", display("working", now + 60_000)),
        agent("thinking", display("thinking", now + 60_000)),
        agent("lapsed", display("online", now - 1)),
        agent("online", display("online", now + 60_000)),
        agent("offline", display("offline")),
        agent("none"),
        agent("roster-busy", display("working", now + 60_000), false),
      ],
      now,
    ),
  ).toEqual(["working", "thinking", "lapsed"]);
});

test("holds the Agents a mounted view reads, first and once, even with no display", () => {
  expect(
    heldDisplayAgentIds(
      [agent("busy", display("working", 90_000)), agent("idle", display("online", 90_000))],
      10_000,
      ["dm-agent", "busy"],
    ),
  ).toEqual(["dm-agent", "busy"]);
});

test("caps the held ids at the limit instead of growing the read past what the server accepts", () => {
  const many = Array.from({ length: HELD_AGENT_IDS_LIMIT + 20 }, (_, i) => `a${i}`);
  const held = heldDisplayAgentIds(
    many.map((id) => agent(id, display("working", 90_000))),
    10_000,
    ["watched"],
  );
  expect(held).toHaveLength(HELD_AGENT_IDS_LIMIT);
  expect(held[0]).toBe("watched");
});

test("a watch registry holds an Agent while any view watches it, and reads it on the first watch", () => {
  const first: string[] = [];
  const registry = createDisplayWatchRegistry((id) => first.push(id));
  const releaseA = registry.watch("x");
  const releaseB = registry.watch("x");
  expect(first).toEqual(["x"]);
  expect(registry.ids()).toEqual(["x"]);
  releaseA();
  releaseA();
  expect(registry.ids()).toEqual(["x"]);
  releaseB();
  expect(registry.ids()).toEqual([]);
  registry.watch("x");
  expect(first).toEqual(["x", "x"]);
});
