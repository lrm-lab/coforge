import { type ChangeSource, diffArgs } from "../git-hooks/staged-file-size";

export const MIGRATION_IMMUTABLE_FIX =
  "A migration that already exists on the base is immutable: restore it byte-for-byte and add a new migration directory for the change. A migration that ran elsewhere is skipped there by name, so its rows would never change.";

const MIGRATION_PATH = /^apps\/web\/prisma\/migrations\/[^/]+\/migration\.sql$/;

type Change = { status: string; path: string; from?: string };

/** The change's files with their `git diff --name-status` status. */
function changedFiles(source: ChangeSource): Change[] {
  const result = Bun.spawnSync(["git", ...diffArgs(source, "--name-status", "-z", "-M", "-l0")]);
  const fields = result.stdout.toString().split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length;) {
    const status = fields[i++]!;
    if (/^[RC]/.test(status)) changes.push({ status, from: fields[i++], path: fields[i++]! });
    else changes.push({ status, path: fields[i++]! });
  }
  return changes;
}

/** Whether `path` exists in `revision` (a commit or `HEAD`). */
function existsInRevision(revision: string, path: string): boolean {
  return (
    Bun.spawnSync(["git", "cat-file", "-e", `${revision}:${path}`], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

/** A migration file the base already had may not be edited, renamed or deleted: an environment
 * that ran it skips the new content by name, so only a new migration directory can change data. */
export function migrationImmutabilityViolations(source: ChangeSource) {
  const base = source.kind === "staged" ? "HEAD" : source.base;
  return changedFiles(source).flatMap((change) => {
    const paths = [change.path, ...(change.from ? [change.from] : [])].filter((path) =>
      MIGRATION_PATH.test(path),
    );
    const existing = paths.find((path) => existsInRevision(base, path));
    return existing
      ? [
          {
            location: existing,
            found: `changed a migration that already exists on ${source.kind === "staged" ? "HEAD" : "the base"}`,
          },
        ]
      : [];
  });
}
