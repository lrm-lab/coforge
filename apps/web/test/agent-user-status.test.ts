import { expect, test } from "bun:test";
import {
  resolveAgentStatus,
  resolveAgentStatuses,
} from "#src/server/agents/agent-user-info.server";

const NOW = Date.now();

function presence(rows: Array<{ agentId: string; live: Date | null; any?: Date | null }>) {
  const calls: Array<readonly string[]> = [];
  return {
    calls,
    presence: async (agentIds: readonly string[]) => (
      calls.push(agentIds),
      rows.map((row) => ({
        agentId: row.agentId,
        liveCount: row.live ? 1 : 0,
        liveLastUsedAt: row.live,
        lastUsedAt: row.any ?? row.live,
      }))
    ),
  };
}

test("external Agents read online or offline from one grouped presence read", async () => {
  const reader = presence([
    { agentId: "a1", live: new Date(NOW - 1000) },
    { agentId: "a2", live: new Date(NOW - 10 * 60_000) },
    { agentId: "a3", live: null, any: new Date(NOW - 1000) },
  ]);
  const result = await resolveAgentStatuses(
    "w1",
    [
      { id: "a1", computerId: null, stoppedAt: null, hosting: "external" },
      { id: "a2", computerId: null, stoppedAt: null, hosting: "external" },
      { id: "a3", computerId: null, stoppedAt: null, hosting: "external" },
      { id: "a4", computerId: null, stoppedAt: null, hosting: "external" },
      { id: "a5", computerId: null, stoppedAt: null },
    ],
    reader,
  );
  expect(result.map((entry) => entry.status)).toEqual([
    "online",
    "offline",
    "offline",
    "offline",
    "unknown",
  ]);
  expect(reader.calls).toEqual([["a1", "a2", "a3", "a4"]]);
});

test("a single external Agent is answered the same way", async () => {
  const reader = presence([{ agentId: "a1", live: new Date(NOW - 1000) }]);
  expect(
    await resolveAgentStatus(
      "w1",
      { id: "a1", computerId: null, stoppedAt: null, hosting: "external" },
      reader,
    ),
  ).toEqual({ status: "online" });
});
