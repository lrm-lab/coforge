import type { AgentWorkspaceFileEntry } from "@lrm/coforge-sdk/internal";
import type { ComputerAgentWorkspaceScan } from "#src/features/computers/computer.schemas";

export type ComputerWorkspaceAgent = {
  id: string;
  name: string;
  displayName: string;
  deletedAt: Date | null;
};

export type WorkspaceDirectoryListing = {
  status: "ok" | "missing" | "unreadable" | "error";
  rootPath: string;
  entries: AgentWorkspaceFileEntry[];
};

type ListWorkspaceDirectory = (input: {
  agentId: string;
  dirPath: string;
  includeHidden: boolean;
}) => Promise<WorkspaceDirectoryListing>;

const MAX_DIRECTORIES = 128;
const MAX_FILES = 10_000;

/**
 * Builds the Computer page's local workspace inventory from the existing directory-list seam.
 * The daemon owns filesystem access; this module only traverses returned metadata. A deleted
 * Agent remains in the owner-only inventory so an
 * owner can identify files that outlived the cloud Agent row's live view.
 */
export async function scanComputerAgentWorkspaces(
  agents: readonly ComputerWorkspaceAgent[],
  listDirectory: ListWorkspaceDirectory,
): Promise<ComputerAgentWorkspaceScan[]> {
  const inventory: ComputerAgentWorkspaceScan[] = [];
  for (const agent of agents) inventory.push(await scanOne(agent, listDirectory));
  return inventory;
}

async function scanOne(
  agent: ComputerWorkspaceAgent,
  listDirectory: ListWorkspaceDirectory,
): Promise<ComputerAgentWorkspaceScan> {
  const base = {
    agentId: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    state: agent.deletedAt ? ("deleted" as const) : ("active" as const),
    rootPath: "",
    fileCount: 0,
    totalSizeBytes: 0,
    modifiedAtMs: 0,
  };

  let root: WorkspaceDirectoryListing;
  try {
    root = await listDirectory({ agentId: agent.id, dirPath: "", includeHidden: true });
  } catch {
    return { ...base, status: "unavailable" };
  }
  if (root.status !== "ok")
    return { ...base, status: root.status === "missing" ? "missing" : "unavailable" };
  base.rootPath = root.rootPath;

  const pending = [{ path: "", entries: root.entries }];
  let directoryCount = 1;
  let partial = false;
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    for (const entry of current.entries) {
      observeEntry(base, entry);
      if (entry.type !== "dir") continue;
      if (directoryCount >= MAX_DIRECTORIES || base.fileCount >= MAX_FILES) {
        partial = true;
        continue;
      }
      directoryCount += 1;
      const path = current.path ? `${current.path}/${entry.name}` : entry.name;
      try {
        const listing = await listDirectory({
          agentId: agent.id,
          dirPath: path,
          includeHidden: true,
        });
        if (listing.status === "ok") pending.push({ path, entries: listing.entries });
        else partial = true;
      } catch {
        partial = true;
      }
    }
  }

  return { ...base, status: partial ? "partial" : "present" };
}

function observeEntry(
  target: Omit<ComputerAgentWorkspaceScan, "status">,
  entry: AgentWorkspaceFileEntry,
) {
  target.modifiedAtMs = Math.max(target.modifiedAtMs, entry.modifiedAtMs);
  if (entry.type !== "file") return;
  target.fileCount += 1;
  target.totalSizeBytes += entry.sizeBytes;
}
