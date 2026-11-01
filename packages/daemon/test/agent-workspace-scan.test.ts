import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanAgentWorkspaceDirectories,
  summarizeAgentWorkspaceDirectories,
} from "#src/agent-runtime/agent-workspace-scan";

// macOS tmpdir lives under /var, a symlink; the path-safety checks reject linked ancestors.
const tempRoot = realpathSync(tmpdir());

test("workspace scan lists every Agent directory with its directory mtime", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-"));
  try {
    await mkdir(join(root, "agent-a"));
    await mkdir(join(root, "agent-b"));
    await Bun.write(join(root, "not-an-agent-file"), "ignored");
    const result = await scanAgentWorkspaceDirectories({ agentsDirectory: root });
    expect(result.status).toBe("ok");
    expect(result.workspaces.map((workspace) => workspace.agentId).sort()).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(result.workspaces.every((workspace) => workspace.modifiedAtMs > 0)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a listing never descends into a workspace, however much it holds", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-listing-"));
  try {
    await mkdir(join(root, "agent-a", "nested"), { recursive: true });
    await Bun.write(join(root, "agent-a", "one.txt"), "one");
    await Bun.write(join(root, "agent-a", "nested", "two.txt"), "twotwo");
    const result = await scanAgentWorkspaceDirectories({ agentsDirectory: root });
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        fileCount: 0,
        totalSizeBytes: 0,
        statisticsStatus: "",
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace statistics count regular files and bytes recursively, including reserved storage", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-stats-"));
  try {
    await mkdir(join(root, "agent-a", "nested"), { recursive: true });
    await Bun.write(join(root, "agent-a", "one.txt"), "one");
    await Bun.write(join(root, "agent-a", "nested", "two.txt"), "twotwo");
    await mkdir(join(root, "agent-a", ".builtin-runtime"));
    await Bun.write(join(root, "agent-a", ".builtin-runtime", "internal.json"), "hidden");
    const result = await summarizeAgentWorkspaceDirectories({ agentsDirectory: root });
    expect(result.status).toBe("ok");
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        fileCount: 3,
        totalSizeBytes: 15,
        statisticsStatus: "complete",
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace that runs out of time reports lower bounds, not a failed scan", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-truncated-"));
  try {
    await mkdir(join(root, "agent-a", "nested"), { recursive: true });
    await Bun.write(join(root, "agent-a", "one.txt"), "one");
    await Bun.write(join(root, "agent-a", "nested", "two.txt"), "twotwo");
    const result = await summarizeAgentWorkspaceDirectories({
      agentsDirectory: root,
      budgets: { workspaceMs: 0, workspaceFiles: 25_000, totalMs: 10_000 },
      now: () => 1_000,
    });
    expect(result.status).toBe("ok");
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        fileCount: 0,
        totalSizeBytes: 0,
        statisticsStatus: "truncated",
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a budget that stops inside the last directory still reports truncated", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-flat-"));
  try {
    // One directory, more files than the budget, and no subdirectory left to visit when the budget
    // runs out: the walk ends through its normal exit, which must not read as "complete".
    await mkdir(join(root, "agent-a"));
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        Bun.write(join(root, "agent-a", `file-${index}.txt`), "x"),
      ),
    );
    const result = await summarizeAgentWorkspaceDirectories({
      agentsDirectory: root,
      budgets: { workspaceMs: 10_000, workspaceFiles: 10, totalMs: 10_000 },
    });
    expect(result.status).toBe("ok");
    const workspace = result.workspaces[0]!;
    expect(workspace.statisticsStatus).toBe("truncated");
    expect(workspace.fileCount).toBeGreaterThanOrEqual(10);
    expect(workspace.fileCount).toBeLessThanOrEqual(80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace after the total budget is skipped rather than measured", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-scan-skipped-"));
  try {
    await mkdir(join(root, "agent-a"));
    await Bun.write(join(root, "agent-a", "one.txt"), "one");
    const result = await summarizeAgentWorkspaceDirectories({
      agentsDirectory: root,
      budgets: { workspaceMs: 500, workspaceFiles: 25_000, totalMs: 0 },
      now: () => 1_000,
    });
    expect(result.status).toBe("ok");
    expect(result.workspaces).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        fileCount: 0,
        totalSizeBytes: 0,
        statisticsStatus: "skipped",
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
