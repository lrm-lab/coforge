import { describe, expect, test } from "bun:test";
import type { AgentWorkspaceScanEntry } from "@lrm/coforge-sdk/internal";

import { agentWorkspaceRows } from "./computer-workspace-scan.server";

const active = { id: "agent-active", name: "ada", displayName: "Ada", deletedAt: null };
const archived = {
  id: "agent-archived",
  name: "lead",
  displayName: "Lead",
  deletedAt: new Date("2026-10-30T00:00:00Z"),
};
const gone = { id: "agent-gone", name: "pref", displayName: "Pref", deletedAt: new Date() };

function entry(agentId: string): AgentWorkspaceScanEntry {
  return {
    agentId,
    status: "present",
    rootPath: `/agents/${agentId}`,
    modifiedAtMs: 1,
    fileCount: 3,
    totalSizeBytes: 30,
    statisticsStatus: "complete",
  };
}

describe("agentWorkspaceRows", () => {
  test("lists only the directories the Computer has, with an orphan after the Agents", () => {
    const rows = agentWorkspaceRows(
      [active, archived, gone],
      [entry("agent-archived"), entry("agent-orphan"), entry("agent-active")],
      true,
    );
    expect(rows.map((row) => [row.agentId, row.state, row.status])).toEqual([
      ["agent-active", "active", "present"],
      ["agent-archived", "deleted", "present"],
      ["agent-orphan", "deleted", "present"],
    ]);
  });

  test("keeps every Agent's row when the Computer did not answer, so it can still be deleted", () => {
    const rows = agentWorkspaceRows([active, gone], undefined, false);
    expect(rows.map((row) => [row.agentId, row.status, row.statisticsStatus])).toEqual([
      ["agent-active", "unavailable", "unavailable"],
      ["agent-gone", "unavailable", "unavailable"],
    ]);
  });

  test("an archived Agent's deleted directory leaves no row", () => {
    expect(agentWorkspaceRows([archived], [], false)).toEqual([]);
  });
});
