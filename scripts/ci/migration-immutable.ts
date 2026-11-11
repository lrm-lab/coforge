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

/** The remote a staged change is judged against: the branch's upstream, else origin/main. A
 * migration not on the remote has run nowhere, so it may still be edited. */
function stagedBase(): string {
  for (const revision of ["@{upstream}", "origin/main"]) {
    const found = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", revision], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (found.exitCode === 0) return revision;
  }
  return "HEAD";
}

/** Migrations deleted without ever running, under Frank's one-time approval of 2026-11-05
 * (tasks #494/#501): production and staging `_prisma_migrations` were re-checked empty for all
 * seven names immediately before the deletion. The list is removed by the release that actually
 * drops the columns (task #501 step 2); until then it would also excuse a same-path recreate. */
const APPROVED_UNAPPLIED_DELETIONS = new Set([
  "apps/web/prisma/migrations/20261105144050_drop_tasks_creator_member_id_idx/migration.sql",
  "apps/web/prisma/migrations/20261105144051_drop_workspace_assistant_display_name/migration.sql",
  "apps/web/prisma/migrations/20261105144052_drop_setup_checklist_dismissed_at/migration.sql",
  "apps/web/prisma/migrations/20261105151638_drop_conversations_project_fk/migration.sql",
  "apps/web/prisma/migrations/20261105151639_drop_conversations_project_idx/migration.sql",
  "apps/web/prisma/migrations/20261105151640_drop_conversations_project_id/migration.sql",
  "apps/web/prisma/migrations/20261105151641_drop_tasks_project_pinned/migration.sql",
  // Task #78: the forward backfill reads `messages`, which migration-safety refuses in production;
  // staging and production never deployed it (their last images predate 1ff35a271).
  "apps/web/prisma/migrations/20261111033020_message_forward_backfill/migration.sql",
]);

/** A migration file the base already had may not be edited, renamed or deleted: an environment
 * that ran it skips the new content by name, so only a new migration directory can change data. */
export function migrationImmutabilityViolations(source: ChangeSource) {
  const base = source.kind === "staged" ? stagedBase() : source.base;
  const baseLabel =
    source.kind === "staged" ? (base === "HEAD" ? "HEAD (no remote)" : "the upstream") : "the base";
  return changedFiles(source).flatMap((change) => {
    const paths = [change.path, ...(change.from ? [change.from] : [])].filter(
      (path) => MIGRATION_PATH.test(path) && !APPROVED_UNAPPLIED_DELETIONS.has(path),
    );
    const existing = paths.find((path) => existsInRevision(base, path));
    return existing
      ? [
          {
            location: existing,
            found: `changed a migration that already exists on ${baseLabel}`,
          },
        ]
      : [];
  });
}
