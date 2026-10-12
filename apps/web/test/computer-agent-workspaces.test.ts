import { describe, expect, test } from "bun:test";
import {
  scanComputerAgentWorkspaces,
  type ComputerWorkspaceAgent,
  type WorkspaceDirectoryListing,
} from "#src/server/computers/computer-agent-workspaces.server";

const agent = (overrides: Partial<ComputerWorkspaceAgent> = {}): ComputerWorkspaceAgent => ({
  id: "agent-1",
  name: "alice",
  displayName: "Alice",
  deletedAt: null,
  ...overrides,
});

function listing(
  agentId: string,
  dirPath: string,
  entries: WorkspaceDirectoryListing["entries"],
  rootPath = `/var/coforge/${agentId}`,
): WorkspaceDirectoryListing {
  return { status: "ok", rootPath: dirPath ? "" : rootPath, entries };
}

describe("scanComputerAgentWorkspaces", () => {
  test("scans Agents sequentially because the Daemon accepts one directory observation at a time", async () => {
    let pending = false;
    const result = await scanComputerAgentWorkspaces(
      [agent(), agent({ id: "agent-2" })],
      async () => {
        if (pending) return { status: "error", rootPath: "", entries: [] };
        pending = true;
        await Promise.resolve();
        pending = false;
        return { status: "ok", rootPath: "", entries: [] };
      },
    );
    expect(result.map((workspace) => workspace.status)).toEqual(["present", "present"]);
  });
  test("summarizes active and deleted Agent workspaces recursively", async () => {
    const directories = new Map<string, WorkspaceDirectoryListing>([
      [
        "agent-1:",
        listing("agent-1", "", [
          { name: "notes", type: "dir", sizeBytes: 0, modifiedAtMs: 10 },
          { name: "MEMORY.md", type: "file", sizeBytes: 12, modifiedAtMs: 20 },
        ]),
      ],
      [
        "agent-1:notes",
        listing("agent-1", "notes", [
          { name: "today.md", type: "file", sizeBytes: 8, modifiedAtMs: 30 },
        ]),
      ],
      ["agent-2:", listing("agent-2", "", [])],
    ]);

    const result = await scanComputerAgentWorkspaces(
      [
        agent(),
        agent({
          id: "agent-2",
          name: "old-alice",
          displayName: "Old Alice",
          deletedAt: new Date(),
        }),
      ],
      async ({ agentId, dirPath }) =>
        directories.get(`${agentId}:${dirPath}`) ?? {
          status: "missing",
          rootPath: "",
          entries: [],
        },
    );

    expect(result).toEqual([
      {
        agentId: "agent-1",
        name: "alice",
        displayName: "Alice",
        state: "active",
        status: "present",
        rootPath: "/var/coforge/agent-1",
        fileCount: 2,
        totalSizeBytes: 20,
        modifiedAtMs: 30,
      },
      {
        agentId: "agent-2",
        name: "old-alice",
        displayName: "Old Alice",
        state: "deleted",
        status: "present",
        rootPath: "/var/coforge/agent-2",
        fileCount: 0,
        totalSizeBytes: 0,
        modifiedAtMs: 0,
      },
    ]);
  });

  test("reports a missing workspace without hiding the Agent identity", async () => {
    const [result] = await scanComputerAgentWorkspaces(
      [agent({ id: "agent-3", name: "missing", displayName: "Missing" })],
      async () => ({ status: "missing", rootPath: "", entries: [] }),
    );

    expect(result).toMatchObject({
      agentId: "agent-3",
      state: "active",
      status: "missing",
      fileCount: 0,
      totalSizeBytes: 0,
    });
  });

  test("past its time budget the scan stops descending and gives each remaining Agent only its root", async () => {
    // Each listing costs 100 ms of a 1 s budget. Every directory holds two more directories, so an
    // unbounded scan would walk 128 directories per Agent (12.8 s each) one after another.
    let now = 0;
    const calls: string[] = [];
    const result = await scanComputerAgentWorkspaces(
      [agent(), agent({ id: "agent-2" }), agent({ id: "agent-3" })],
      async ({ agentId, dirPath }) => {
        calls.push(`${agentId}:${dirPath}`);
        now += 100;
        return listing(agentId, dirPath, [
          { name: "a", type: "dir", sizeBytes: 0, modifiedAtMs: 1 },
          { name: "b", type: "dir", sizeBytes: 0, modifiedAtMs: 1 },
        ]);
      },
      { budgetMs: 1_000, now: () => now },
    );

    expect(result.map((workspace) => workspace.status)).toEqual(["partial", "partial", "partial"]);
    // The first Agent spends the budget; the other two are listed at their root and nothing more.
    expect(calls.filter((call) => call.startsWith("agent-1:"))).toHaveLength(10);
    expect(calls.filter((call) => !call.startsWith("agent-1:"))).toEqual(["agent-2:", "agent-3:"]);
  });
});
