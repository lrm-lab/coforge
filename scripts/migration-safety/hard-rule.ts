// Hard rule migration-safety (scripts/ci/hard-rules.ts): a migration the change ADDS, with a
// high-risk statement, must carry a valid safety annotation (check-migration.ts). Migrations
// already in the base are never looked at. The pre-commit hook has no snapshot, so it checks what
// is checkable offline; CI (GITHUB_ACTIONS or CI set) also needs MIGRATION_SAFETY_SNAPSHOT, the
// path of the latest production catalog snapshot (downloaded with `gh` when it is unset), and fails
// closed for a high-risk migration without one.
import { readFiles, resultRevision } from "../ci/hard-rules";
import { type ChangeSource, diffArgs, git } from "../git-hooks/staged-file-size";
import { downloadLatestSnapshot } from "./fetch-snapshot";
import { isGrandfathered } from "./grandfather";
import { createdTables } from "./rules";
import { catalogOf, loadSnapshot } from "./snapshot";
import { REWRITE_IN_STEPS, verifyMigration } from "./verify";

export const MIGRATION_SAFETY_FIX = `A migration with a high-risk statement (a lock or rewrite of an existing table, a destructive change, or anything the check does not recognise) needs an annotation from the catalog snapshot: download the latest catalog-snapshot artifact (\`gh run download --name catalog-snapshot-production\`), run \`bun scripts/migration-safety/check-migration.ts --write --snapshot <snapshot.json> <migration.sql>\`, and commit the file with its annotation. If it says the migration must be rewritten, ${REWRITE_IN_STEPS}. Do not edit the body after annotating. The rule has no override. See docs/agents/git-hooks/hard-rules.md.`;

const MIGRATION = /^apps\/web\/prisma\/migrations\/([^/]+)\/migration\.sql$/;
const CREATES_A_TABLE = /CREATE\s+(UNLOGGED\s+)?TABLE/i;

/** Migrations the change adds (status A, with renames off so a moved file counts as new). */
function addedMigrations(source: ChangeSource): string[] {
  const fields = git(diffArgs(source, "--name-status", "-z", "--no-renames", "--diff-filter=A"))
    .toString()
    .split("\0");
  const added: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const name = MIGRATION.exec(fields[i + 1]!)?.[1];
    if (name !== undefined && !isGrandfathered(name)) added.push(fields[i + 1]!);
  }
  return added;
}

/** For each table, the migrations of the result that create it. Read only to judge a migration
 * that needs a verdict; files that cannot create a table are not tokenized. */
function creators(source: ChangeSource): Map<string, Set<string>> {
  const tree =
    source.kind === "staged"
      ? ["ls-files", "-z"]
      : ["ls-tree", "-r", "-z", "--name-only", source.head];
  const paths = git([...tree, "apps/web/prisma/migrations"])
    .toString()
    .split("\0")
    .filter((path) => MIGRATION.test(path));
  const byTable = new Map<string, Set<string>>();
  for (const [path, sql] of readFiles(resultRevision(source), paths)) {
    if (!CREATES_A_TABLE.test(sql)) continue;
    for (const table of createdTables(sql))
      byTable.set(table, (byTable.get(table) ?? new Set()).add(path));
  }
  return byTable;
}

export function migrationSafetyViolations(
  source: ChangeSource,
  env: NodeJS.ProcessEnv = process.env,
) {
  const added = addedMigrations(source);
  if (added.length === 0) return [];
  const inCi = env.GITHUB_ACTIONS === "true" || env.CI === "true";
  // Both are read once, and only for a migration that needs a verdict. The snapshot is downloaded
  // only when MIGRATION_SAFETY_SNAPSHOT is not set (to a path, or to nothing to skip the download).
  let byTable: Map<string, Set<string>> | undefined;
  let catalog: { answer: ReturnType<typeof fromSnapshot> } | undefined;
  const fromSnapshot = () => {
    const snapshot = loadSnapshot(env.MIGRATION_SAFETY_SNAPSHOT ?? downloadLatestSnapshot(env));
    return snapshot && { tables: catalogOf(snapshot), snapshot };
  };
  const now = new Date();
  return [...readFiles(resultRevision(source), added)].flatMap(([file, text]) =>
    verifyMigration(text, {
      file,
      now,
      createdElsewhere: () => {
        byTable ??= creators(source);
        return new Set(
          [...byTable]
            .filter(([, files]) => [...files].some((f) => f !== file))
            .map(([table]) => table),
        );
      },
      catalog: inCi ? () => (catalog ??= { answer: fromSnapshot() }).answer : undefined,
      requireCatalog: inCi,
    }).problems.map((problem) => ({
      rule: "migration-safety" as const,
      location: file,
      found: problem,
    })),
  );
}
