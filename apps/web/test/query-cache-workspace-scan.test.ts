import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  agentWorkspaceScanQuery,
  type AgentWorkspaceScanSnapshot,
} from "#src/features/computers/agent-workspace-scan.query";

import {
  dataBecomes,
  memoryStore,
  pageLoad,
  queryRows,
  settle,
} from "./helpers/query-cache-harness";

describe("a Computer's Agent workspace scan", () => {
  const snapshot: AgentWorkspaceScanSnapshot = {
    scannedAt: 1_790_000_000_000,
    workspaces: [
      {
        agentId: "agent-1",
        name: "ada",
        displayName: "Ada",
        state: "active",
        status: "present",
        rootPath: "/home/ada/.coforge/agents/agent-1",
        modifiedAtMs: 1_790_000_000_000,
        fileCount: 2,
        totalSizeBytes: 456,
        statisticsStatus: "complete",
      },
    ],
  };
  /** The page's query (`agent-workspace-scan.query.ts`), with its read counted: a read is not a
   * scan, but one after a restore would replace the copy with "never scanned". */
  const scanQuery = () => {
    const options = agentWorkspaceScanQuery("w1", "computer-1");
    let reads = 0;
    return {
      reads: () => reads,
      options: {
        ...options,
        queryFn: (): AgentWorkspaceScanSnapshot | null => {
          reads += 1;
          return null;
        },
      },
    };
  };

  test("is kept once Scan wrote it, and opens the next page load without being read again", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    // Scan writes its result into the query and stores it, as the Computer page does.
    const key = agentWorkspaceScanQuery("w1", "computer-1").queryKey;
    before.queryClient.setQueryData(key, snapshot);
    await before.persistence.store(key);
    expect(disk.writes()).toBe(1);

    const after = pageLoad(disk.store);
    const { options, reads } = scanQuery();
    new QueryObserver(after.queryClient, options).subscribe(() => {});
    await dataBecomes<AgentWorkspaceScanSnapshot | null>(
      after.queryClient,
      options.queryKey,
      (data) => data !== null,
    );
    await settle();
    await settle();
    expect(
      after.queryClient.getQueryData<AgentWorkspaceScanSnapshot | null>(options.queryKey),
    ).toEqual(snapshot);
    expect(after.queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    expect(reads()).toBe(0);
  });

  test("is stored before the scan counts as done, not a page-write delay later", async () => {
    const disk = memoryStore();
    // Storage that takes the row only when the test lets it: the scan is done once it has.
    let commit: () => void = () => {};
    const committed = new Promise<void>((resolve) => (commit = resolve));
    const set = disk.store.set;
    const page = pageLoad({
      ...disk.store,
      set: async (key, value) => {
        if (key.includes("tanstack-query-")) await committed;
        return set(key, value);
      },
    });
    const key = agentWorkspaceScanQuery("w1", "computer-1").queryKey;
    page.queryClient.setQueryData(key, snapshot);
    let stored = false;
    const storing = page.persistence.store(key).then(() => (stored = true));
    try {
      await settle();
      expect({ stored, rows: queryRows(disk.rows).length }).toEqual({ stored: false, rows: 0 });
    } finally {
      // Released whatever the assertion said, so no write is left waiting on the gate.
      commit();
    }
    await storing;
    expect(queryRows(disk.rows)).toHaveLength(1);
  });

  test("is nothing until the first scan, and nothing is stored for it", async () => {
    const disk = memoryStore();
    const page = pageLoad(disk.store);
    const { options, reads } = scanQuery();
    expect(await page.queryClient.fetchQuery(options)).toBeNull();
    await settle();
    expect(reads()).toBe(1);
    expect(queryRows(disk.rows)).toEqual([]);
  });
});
