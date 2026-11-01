import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentWorkspaceStatisticsStatus } from "@lrm/coforge-sdk/internal";
import { isENOENT } from "./agent-workspace-files";

export type AgentWorkspaceDirectoriesScanOutcome = {
  status: "ok" | "missing" | "unavailable";
  workspaces: Array<{
    agentId: string;
    status: "present";
    rootPath: string;
    modifiedAtMs: number;
    /** Lower bounds when `statisticsStatus` is "truncated"; 0 when the walk was skipped. */
    fileCount: number;
    totalSizeBytes: number;
    /** Empty for a listing-only scan. */
    statisticsStatus: AgentWorkspaceStatisticsStatus | "";
  }>;
};

/** How long a statistics walk may spend, so a Computer with a multi-million-file agents
 * directory still answers the listing immediately and the measurements within the web tier's
 * five-second result timeout. */
export type AgentWorkspaceStatisticsBudgets = {
  workspaceMs: number;
  workspaceFiles: number;
  totalMs: number;
};

export const AGENT_WORKSPACE_STATISTICS_BUDGETS: AgentWorkspaceStatisticsBudgets = {
  workspaceMs: 500,
  workspaceFiles: 25_000,
  totalMs: 2_000,
};

/** Keep four Agent workspaces moving without flooding a local disk with stat calls. */
const WORKSPACE_SCAN_CONCURRENCY = 4;
const WORKSPACE_SCAN_STAT_CONCURRENCY = 32;
/** Directories walked together within one workspace: measured ~2x the throughput of one at a
 * time (2 s over the real agents directory: 66k files/s at 64 directories, 30k/s sequentially). */
const WORKSPACE_SCAN_DIRECTORY_BATCH = 64;

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        await work(values[index]!);
      }
    }),
  );
}

/**
 * Lists every Agent directory in one local filesystem pass, without descending into any of them.
 * A workspace can hold millions of files (an Agent's repositories and their dependencies), so a
 * listing stays a handful of `readdir`/`lstat` calls: presence, the root path, the directory's own
 * modification time, and — the only things delete needs — nothing that scales with its contents.
 */
export async function scanAgentWorkspaceDirectories(params: {
  agentsDirectory: string;
}): Promise<AgentWorkspaceDirectoriesScanOutcome> {
  const listed = await listAgentWorkspaceDirectories(params.agentsDirectory);
  if (listed.status !== "ok") return { status: listed.status, workspaces: [] };
  return {
    status: "ok",
    workspaces: listed.directories.map((entry) => ({
      agentId: entry.agentId,
      status: "present" as const,
      rootPath: entry.rootPath,
      modifiedAtMs: entry.modifiedAtMs,
      fileCount: 0,
      totalSizeBytes: 0,
      statisticsStatus: "" as const,
    })),
  };
}

/**
 * The same listing plus each workspace's file count and size, walked under explicit budgets: at
 * most `workspaceMs` or `workspaceFiles` per workspace, and `totalMs` for the whole response.
 * A workspace that hits its budget reports the counts it reached and "truncated" (lower bounds);
 * one whose turn comes after the total budget is "skipped". The response never fails because a
 * workspace is large.
 */
export async function summarizeAgentWorkspaceDirectories(params: {
  agentsDirectory: string;
  budgets?: AgentWorkspaceStatisticsBudgets;
  now?: () => number;
}): Promise<AgentWorkspaceDirectoriesScanOutcome> {
  const budgets = params.budgets ?? AGENT_WORKSPACE_STATISTICS_BUDGETS;
  const now = params.now ?? Date.now;
  const deadline = now() + budgets.totalMs;
  const listed = await listAgentWorkspaceDirectories(params.agentsDirectory);
  if (listed.status !== "ok") return { status: listed.status, workspaces: [] };
  const workspaces: AgentWorkspaceDirectoriesScanOutcome["workspaces"] = [];
  await runBounded(listed.directories, WORKSPACE_SCAN_CONCURRENCY, async (entry) => {
    const measured =
      now() >= deadline
        ? { fileCount: 0, totalSizeBytes: 0, truncated: true, skipped: true }
        : {
            ...(await measureWorkspaceDirectory(entry.rootPath, {
              deadline: Math.min(deadline, now() + budgets.workspaceMs),
              fileBudget: budgets.workspaceFiles,
              now,
            })),
            skipped: false,
          };
    workspaces.push({
      agentId: entry.agentId,
      status: "present" as const,
      rootPath: entry.rootPath,
      modifiedAtMs: entry.modifiedAtMs,
      fileCount: measured.fileCount,
      totalSizeBytes: measured.totalSizeBytes,
      statisticsStatus: measured.skipped
        ? "skipped"
        : measured.truncated
          ? "truncated"
          : "complete",
    });
  });
  workspaces.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { status: "ok", workspaces };
}

async function listAgentWorkspaceDirectories(agentsDirectory: string): Promise<
  | {
      status: "ok";
      directories: Array<{ agentId: string; rootPath: string; modifiedAtMs: number }>;
    }
  | { status: "missing" | "unavailable" }
> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(agentsDirectory, { withFileTypes: true });
  } catch (error) {
    return { status: isENOENT(error) ? "missing" : "unavailable" };
  }
  const directories: Array<{ agentId: string; rootPath: string; modifiedAtMs: number }> = [];
  await runBounded(
    entries.filter((entry) => entry.isDirectory()),
    WORKSPACE_SCAN_CONCURRENCY,
    async (entry) => {
      const rootPath = join(agentsDirectory, entry.name);
      try {
        const info = await lstat(rootPath);
        directories.push({
          agentId: entry.name,
          rootPath,
          modifiedAtMs: Math.round(info.mtimeMs),
        });
      } catch {
        // A directory may disappear between readdir and lstat; the next scan will reconcile it.
      }
    },
  );
  directories.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { status: "ok", directories };
}

/** Counts and sizes every regular file below one workspace until its budget runs out. Symlinks are
 * not followed; the runtime's reserved directories count, because deleting the workspace removes
 * them too. */
async function measureWorkspaceDirectory(
  rootPath: string,
  options: { deadline: number; fileBudget: number; now: () => number },
): Promise<{ fileCount: number; totalSizeBytes: number; truncated: boolean }> {
  const queue = [rootPath];
  let fileCount = 0;
  let totalSizeBytes = 0;
  const exhausted = () => options.now() >= options.deadline || fileCount >= options.fileBudget;
  while (queue.length > 0) {
    if (exhausted()) return { fileCount, totalSizeBytes, truncated: true };
    const batch = queue.splice(0, WORKSPACE_SCAN_DIRECTORY_BATCH);
    const nextDirectories: string[] = [];
    await Promise.all(
      batch.map(async (directory) => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries)
          if (entry.isDirectory()) nextDirectories.push(join(directory, entry.name));
        const files = entries.filter((entry) => entry.isFile());
        for (let offset = 0; offset < files.length; offset += WORKSPACE_SCAN_STAT_CONCURRENCY) {
          if (exhausted()) return;
          const slice = files.slice(offset, offset + WORKSPACE_SCAN_STAT_CONCURRENCY);
          const infos = await Promise.all(
            slice.map(async (entry) => {
              try {
                return await lstat(join(directory, entry.name));
              } catch {
                // A file that changes during a scan is omitted; the next one reconciles it.
                return undefined;
              }
            }),
          );
          for (const info of infos) {
            if (!info?.isFile()) continue;
            fileCount += 1;
            totalSizeBytes += info.size;
          }
        }
      }),
    );
    queue.push(...nextDirectories);
  }
  return { fileCount, totalSizeBytes, truncated: false };
}
