import { queryOptions } from "@tanstack/react-query";

import type { ComputerAgentWorkspaceScan } from "./computer.schemas";

/** A Computer's last Agent workspace scan: when it was taken, and what it found. */
export type AgentWorkspaceScanSnapshot = {
  scannedAt: number;
  workspaces: ComputerAgentWorkspaceScan[];
};

/**
 * The Computer's last Agent workspace scan in this Workspace, kept in the browser
 * (`features/cache-persistence/persisted-queries.ts`) so a reload still shows it.
 *
 * The scan itself reads the Computer's disk (seconds per Agent), so it runs only when the owner
 * presses Scan, which writes its result here (`setQueryData`). The query's own read finds nothing
 * (`null`: never scanned), a restored copy is not followed by one, and `staleTime: Infinity` keeps
 * the page from ever reading it on its own.
 */
export const agentWorkspaceScanQuery = (workspaceId: string, computerId: string) =>
  queryOptions<AgentWorkspaceScanSnapshot | null>({
    queryKey: ["computer-agent-workspaces", workspaceId, computerId],
    queryFn: () => null,
    staleTime: Infinity,
  });
