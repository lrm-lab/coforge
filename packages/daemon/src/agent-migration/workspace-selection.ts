import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COFORGE_RUNTIME_STORAGE_DIRS, PI_SESSION_DIR } from "@coforge/agent";
import {
  AGENT_MIGRATION_COMMIT_DIRECTORY,
  AGENT_MIGRATION_IGNORE_FILE,
  ALWAYS_MOVED,
  isSecretName,
  isWorkspaceSymlinkTarget,
  parseIgnoredPaths,
  regenerableCategory,
  type RegenerableCategory,
} from "./selection-rules";

/**
 * Walks an Agent's workspace and applies the selection rules (`selection-rules.ts`): which files
 * an Agent migration carries to the target Computer, and what it leaves behind and why. Secrets
 * and the built-in runtime's own storage stay on the source; only their paths are reported so the
 * user can copy them by hand. A path that cannot be read is recorded and the walk carries on.
 */

export { AGENT_MIGRATION_IGNORE_FILE };

/** Runtime-owned storage in the workspace root: auth, models and every runtime's Sessions. */
const RUNTIME_STORAGE: ReadonlySet<string> = new Set([
  ...COFORGE_RUNTIME_STORAGE_DIRS,
  PI_SESSION_DIR,
]);

/** How many file sizes one directory reads at once. */
const STAT_CONCURRENCY = 32;

export type AgentMigrationWorkspaceEntry =
  | { path: string; kind: "file"; sizeBytes: number }
  | { path: string; kind: "symlink"; linkTarget: string };

export type AgentMigrationPathTotals = { fileCount: number; sizeBytes: number };

export type AgentMigrationWorkspaceSelection = {
  /** Workspace-relative POSIX paths, sorted, that the migration carries. */
  entries: AgentMigrationWorkspaceEntry[];
  excluded: {
    regenerable: { path: string; category: RegenerableCategory }[];
    ignored: ({ path: string } & AgentMigrationPathTotals)[];
    /** Secret files and credential directories left on the source; paths only. */
    secret: string[];
    runtimeStorage: string[];
    unsafeSymlinks: string[];
    /** Paths that could not be read; the workspace root is `.`. */
    unreadable: string[];
  };
};

const workspaceLabel = (path: string) => path || ".";

/** The ignore file's paths; a missing or non-regular ignore file lists nothing. */
async function readIgnoredPaths(root: string): Promise<Set<string>> {
  const path = join(root, AGENT_MIGRATION_IGNORE_FILE);
  try {
    if (!(await lstat(path)).isFile()) return new Set();
    return parseIgnoredPaths(await readFile(path, "utf8"), root);
  } catch {
    return new Set();
  }
}

export async function selectAgentMigrationWorkspace(
  workspaceDirectory: string,
): Promise<AgentMigrationWorkspaceSelection> {
  const root = await realpath(resolve(workspaceDirectory)).catch(() => null);
  if (!root || !(await lstat(root)).isDirectory())
    throw new Error(`Agent workspace ${resolve(workspaceDirectory)} is missing`);
  const ignoredPaths = await readIgnoredPaths(root);
  const entries: AgentMigrationWorkspaceEntry[] = [];
  const excluded: AgentMigrationWorkspaceSelection["excluded"] = {
    regenerable: [],
    ignored: [],
    secret: [],
    runtimeStorage: [],
    unsafeSymlinks: [],
    unreadable: [],
  };

  const listDirectory = async (path: string): Promise<Dirent[] | null> => {
    try {
      return await readdir(path ? join(root, path) : root, { withFileTypes: true });
    } catch {
      excluded.unreadable.push(workspaceLabel(path));
      return null;
    }
  };

  /** Counts what an ignored path leaves behind: every non-directory entry, sized if a file. */
  const measure = async (path: string, dirent: Dirent): Promise<AgentMigrationPathTotals> => {
    if (!dirent.isDirectory()) {
      const sizeBytes = dirent.isFile()
        ? await lstat(join(root, path)).then(
            (s) => s.size,
            () => 0,
          )
        : 0;
      return { fileCount: 1, sizeBytes };
    }
    const total = { fileCount: 0, sizeBytes: 0 };
    for (const child of (await listDirectory(path)) ?? []) {
      const nested = await measure(`${path}/${child.name}`, child);
      total.fileCount += nested.fileCount;
      total.sizeBytes += nested.sizeBytes;
    }
    return total;
  };

  const visit = async (directoryPath: string): Promise<void> => {
    const dirents = await listDirectory(directoryPath);
    if (!dirents) return;
    const directory = directoryPath ? join(root, directoryPath) : root;
    const files: string[] = [];
    const subdirectories: string[] = [];
    for (const dirent of dirents) {
      const path = directoryPath ? `${directoryPath}/${dirent.name}` : dirent.name;
      // Only the root holds the runtime's storage; a same-named folder deeper down is the Agent's.
      if (!directoryPath && dirent.name === AGENT_MIGRATION_COMMIT_DIRECTORY) {
        // The migration's own state from an earlier move, not the Agent's.
      } else if (!directoryPath && RUNTIME_STORAGE.has(dirent.name)) {
        excluded.runtimeStorage.push(path);
      } else if (!ALWAYS_MOVED.has(path) && isSecretName(dirent.name)) {
        // Before the ignore list, so an ignored secret is still on the copy-by-hand list.
        excluded.secret.push(path);
      } else if (ignoredPaths.has(path)) {
        excluded.ignored.push({ path, ...(await measure(path, dirent)) });
      } else if (dirent.isDirectory()) {
        const category = regenerableCategory(dirent.name);
        if (category) excluded.regenerable.push({ path, category });
        else subdirectories.push(path);
      } else if (dirent.isFile()) {
        files.push(path);
      } else if (dirent.isSymbolicLink()) {
        const linkTarget = await readlink(join(root, path)).catch(() => null);
        if (linkTarget === null) excluded.unreadable.push(path);
        else if (isWorkspaceSymlinkTarget(root, directory, linkTarget))
          entries.push({ path, kind: "symlink", linkTarget });
        else excluded.unsafeSymlinks.push(path);
      }
      // Sockets, FIFOs and devices have no content to carry.
    }
    for (let start = 0; start < files.length; start += STAT_CONCURRENCY) {
      const batch = files.slice(start, start + STAT_CONCURRENCY);
      // A file removed since the listing is simply no longer part of the workspace.
      const sizes = await Promise.all(
        batch.map((path) =>
          lstat(join(root, path)).then(
            (stats) => stats.size,
            () => null,
          ),
        ),
      );
      batch.forEach((path, index) => {
        const sizeBytes = sizes[index];
        if (sizeBytes != null) entries.push({ path, kind: "file", sizeBytes });
      });
    }
    for (const path of subdirectories) await visit(path);
  };
  await visit("");

  const byPath = (left: { path: string }, right: { path: string }) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  entries.sort(byPath);
  excluded.regenerable.sort(byPath);
  excluded.ignored.sort(byPath);
  excluded.secret.sort();
  excluded.runtimeStorage.sort();
  excluded.unsafeSymlinks.sort();
  excluded.unreadable.sort();
  return { entries, excluded };
}
