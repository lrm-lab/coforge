// The migration safety check (docs/agents/git-hooks/hard-rules.md, rule migration-safety).
//
//   bun scripts/migration-safety/check-migration.ts --write --snapshot <file> <migration.sql>...
//       Judges each file against the catalog snapshot and writes the annotation at its top.
//   bun scripts/migration-safety/check-migration.ts --verify <migration.sql>...
//       Offline: the annotation's format, its hash of the body, and its agreement with the statements.
//   bun scripts/migration-safety/check-migration.ts --ci --snapshot <file> <migration.sql>...
//       --verify, plus the verdict recomputed from the snapshot. A missing or stale snapshot fails.
//   bun scripts/migration-safety/check-migration.ts --deploy [--migrations <dir>]
//       On the deploy host, before `migrate deploy`: the pending migrations against the live catalog.
// Exit 0 when every file passes, 1 when one is rejected, 2 on bad usage or unreadable input.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { formatAnnotation, PG_VERSION, split } from "./annotation";
import { createdTables, analyze, judge } from "./rules";
import { listMigrations } from "./migration-files";
import { catalogOf, loadSnapshot, type Snapshot } from "./snapshot";
import { REWRITE_IN_STEPS, verifyMigration } from "./verify";

const USAGE =
  "usage: check-migration.ts --verify <migration.sql>... | --ci --snapshot <file> <migration.sql>... | --write --snapshot <file> <migration.sql>... | --deploy [--migrations <dir>]";

/** Tables created by the other migrations beside `file` (its directory's siblings). */
export function createdBySiblings(file: string): Set<string> {
  const own = resolve(file);
  const created = new Set<string>();
  for (const sibling of listMigrations(dirname(dirname(own))))
    if (resolve(sibling.file) !== own)
      for (const table of createdTables(readFileSync(sibling.file, "utf8"))) created.add(table);
  return created;
}

function write(file: string, snapshot: Snapshot, now: Date): string[] {
  const text = readFileSync(file, "utf8");
  const body = split(text).body;
  const analysis = analyze(body);
  if (analysis.problems.length > 0)
    return analysis.problems.map((problem) => `${file}: ${problem}`);
  if (!analysis.highRisk) {
    console.log(`${file}: no high-risk statements, so no annotation is needed`);
    return [];
  }
  const judgement = judge(analysis, catalogOf(snapshot), createdBySiblings(file));
  if (judgement.verdict === "rewrite")
    return [
      `${file}: not annotated, it must be rewritten: ${judgement.rewrites.map((effect) => `line ${effect.line} ${effect.label} on ${effect.table ?? "a table it names"}`).join("; ")}. ${REWRITE_IN_STEPS}.`,
    ];
  const annotated = formatAnnotation(
    {
      checked: now.toISOString(),
      pg: PG_VERSION,
      verdict: judgement.verdict,
      snapshotAt: snapshot.generatedAt,
      snapshotEnvironment: snapshot.environment,
      tables: judgement.lines,
    },
    body,
  );
  writeFileSync(file, annotated);
  console.log(`${file}: verdict ${judgement.verdict}, annotation written`);
  return [];
}

export async function main(args: string[], now = new Date()): Promise<number> {
  const mode = args.find((arg) => ["--write", "--verify", "--ci", "--deploy"].includes(arg));
  const snapshotAt = args.indexOf("--snapshot");
  const snapshotPath = snapshotAt >= 0 ? args[snapshotAt + 1] : undefined;
  const files = args.filter(
    (arg, at) =>
      !arg.startsWith("--") && args[at - 1] !== "--snapshot" && args[at - 1] !== "--migrations",
  );
  if (mode === "--deploy") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("check-migration: --deploy needs DATABASE_URL");
      return 2;
    }
    // Loaded here so that the offline modes never import the database client.
    const [{ deployGate }, { liveSource }] = await Promise.all([
      import("./deploy-gate"),
      import("./catalog-query"),
    ]);
    const dirAt = args.indexOf("--migrations");
    return deployGate(liveSource(url), dirAt >= 0 ? args[dirAt + 1]! : "prisma/migrations", now);
  }
  if (!mode || files.length === 0 || (mode !== "--verify" && snapshotAt < 0)) {
    console.error(USAGE);
    return 2;
  }
  // An unreadable snapshot is as good as none: --ci fails closed below, --write cannot proceed.
  const snapshot = loadSnapshot(snapshotPath);
  const problems: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`check-migration: ${file} not found`);
      return 2;
    }
    if (mode === "--write") {
      if (!snapshot) {
        console.error(
          `check-migration: --write needs a readable catalog snapshot (--snapshot <file>)`,
        );
        return 2;
      }
      problems.push(...write(file, snapshot, now));
      continue;
    }
    const result = verifyMigration(readFileSync(file, "utf8"), {
      file,
      now,
      createdElsewhere: () => createdBySiblings(file),
      catalog:
        mode === "--ci" && snapshot ? () => ({ tables: catalogOf(snapshot), snapshot }) : undefined,
      requireCatalog: mode === "--ci",
    });
    problems.push(...result.problems.map((problem) => `${file}: ${problem}`));
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) return 1;
  console.log(`check-migration: ${files.length} file(s) ok (${basename(mode)})`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
