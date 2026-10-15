import type { Dirent } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  utimes,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { AgentMigrationCommitError } from "./commit-error";

/**
 * The workspaces a migration moves out of the way on this Computer, one directory per Agent under
 * `migration-workspace-backups/`: on the target, the workspace a placement replaced
 * (`preexisting-<migrationId>`); on the source, the workspace an Agent left behind when it moved
 * away (`source-<migrationId>`). As in the reference Computer, a few of the newest are kept for a
 * while, so a move can be undone by hand, and the rest are pruned.
 */

/** Headroom kept free beyond the tree's own size when a move has to copy across devices. */
const COPY_HEADROOM_BYTES = 256 * 1024 * 1024;
/** How many backups of one Agent are kept, and for how long at most. */
export const AGENT_WORKSPACE_BACKUPS_KEPT = 3;
export const AGENT_WORKSPACE_BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const preexistingBackupName = (migrationId: string) => `preexisting-${migrationId}`;
export const sourceBackupName = (migrationId: string) => `source-${migrationId}`;

/** Whether anything, even a dangling link, is at the path. */
export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Every path's description and the tree's file bytes, for copy verification and disk headroom. */
async function describeTree(root: string) {
  const lines: string[] = [];
  let sizeBytes = 0;
  const walk = async (directory: string) => {
    const dirents: Dirent[] = await readdir(directory, { withFileTypes: true });
    for (const dirent of dirents.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(directory, dirent.name);
      const name = relative(root, path);
      if (dirent.isDirectory()) {
        lines.push(`d ${name}`);
        await walk(path);
      } else if (dirent.isSymbolicLink()) lines.push(`l ${name} ${await readlink(path)}`);
      else {
        const { size } = await lstat(path);
        lines.push(`f ${name} ${size}`);
        sizeBytes += size;
      }
    }
  };
  await walk(root);
  return { lines, sizeBytes };
}

/**
 * Moves a workspace out of the way, intact, to `name` under the backup directory. Across devices
 * it is copied beside the backup name, checked against the original, renamed into place, and only
 * then removed from where it was. The backup is stamped with when it was made, for pruning.
 */
export async function moveWorkspaceToBackup(
  workspaceDirectory: string,
  backupDirectory: string,
  name: string,
) {
  const stats = await lstat(workspaceDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new AgentMigrationCommitError(
      "workspace_invalid",
      "the workspace is not a real directory",
    );
  const fromBackups = relative(workspaceDirectory, backupDirectory);
  if (fromBackups === "" || (!fromBackups.startsWith("..") && !fromBackups.startsWith(sep)))
    throw new AgentMigrationCommitError(
      "workspace_invalid",
      "backups would land inside the workspace",
    );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const to = join(backupDirectory, name);
  if (await exists(to))
    throw new AgentMigrationCommitError("backup_conflict", `${to} already exists`);
  try {
    await rename(workspaceDirectory, to);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    const needed = (await describeTree(workspaceDirectory)).sizeBytes + COPY_HEADROOM_BYTES;
    const free = await statfs(backupDirectory);
    if (free.bavail * free.bsize < needed)
      throw new AgentMigrationCommitError(
        "insufficient_disk",
        `${needed} bytes needed for the backup copy`,
      );
    const partial = `${to}.partial-${crypto.randomUUID()}`;
    try {
      await cp(workspaceDirectory, partial, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
      });
      if (
        (await describeTree(workspaceDirectory)).lines.join("\n") !==
        (await describeTree(partial)).lines.join("\n")
      )
        throw new AgentMigrationCommitError(
          "backup_copy_mismatch",
          "the backup copy differs from the workspace",
        );
      await rename(partial, to);
    } catch (copyError) {
      await rm(partial, { recursive: true, force: true });
      throw copyError;
    }
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
  // Backups are kept and pruned by age; stamp when this one was made.
  const now = new Date();
  await utimes(to, now, now);
  return to;
}

/**
 * Keeps an Agent's newest backups and drops the rest: anything past the newest
 * `AGENT_WORKSPACE_BACKUPS_KEPT`, and anything older than `AGENT_WORKSPACE_BACKUP_MAX_AGE_MS`.
 * A copy still in progress (`.partial-*`) is never touched.
 */
export async function pruneWorkspaceBackups(backupDirectory: string, now = Date.now()) {
  const names = await readdir(backupDirectory).catch(() => [] as string[]);
  const found = await Promise.all(
    names
      .filter((name) => !name.includes(".partial-"))
      .map(async (name) => {
        // One removed meanwhile is simply not there to prune.
        const made = await stat(join(backupDirectory, name)).catch(() => null);
        return made ? { name, madeAt: made.mtimeMs } : null;
      }),
  );
  const backups = found.filter((backup) => backup !== null);
  backups.sort((left, right) => right.madeAt - left.madeAt);
  await Promise.all(
    backups
      .filter(
        (backup, index) =>
          index >= AGENT_WORKSPACE_BACKUPS_KEPT ||
          now - backup.madeAt > AGENT_WORKSPACE_BACKUP_MAX_AGE_MS,
      )
      .map((backup) => rm(join(backupDirectory, backup.name), { recursive: true, force: true })),
  );
}
