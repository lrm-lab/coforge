// Checks one migration file against its annotation, offline or against a catalog. Every consumer
// (the hard rule, `check-migration.ts`, the deploy gate) goes through `verifyMigration`.
import { type Annotation, keys, parseAnnotation, PG_VERSION, sha256 } from "./annotation";
import { analyze, judge, type Judgement, type Analysis } from "./rules";
import { type Catalog, MAX_SNAPSHOT_AGE_DAYS, type Snapshot, snapshotAgeDays } from "./snapshot";

/** What to do about a migration that cannot be rewritten as it stands. */
export const REWRITE_IN_STEPS =
  "rewrite the migration in steps (expand-contract / NOT VALID + VALIDATE / CONCURRENTLY)";

export const REMEDY = (file: string) =>
  `re-run \`bun scripts/migration-safety/check-migration.ts --write --snapshot <latest snapshot>\` for ${file} (download the latest catalog-snapshot artifact), or ${REWRITE_IN_STEPS}`;

export type VerifyContext = {
  file: string;
  now: Date;
  /** Tables other migrations create (and that a catalog may not have yet); read only to judge. */
  createdElsewhere: () => ReadonlySet<string>;
  /** What to judge against: a snapshot (CI), a live catalog (deploy), or nothing (offline). It is
   * asked for only once a migration needs a verdict, and may answer none. */
  catalog?: () => { tables: Catalog; snapshot?: Snapshot } | undefined;
  /** Without a catalog, a migration that needs a verdict fails: the check could not be made. */
  requireCatalog?: boolean;
};

export type Verification = {
  /** Each worded with what to do; the caller adds the file's name. */
  problems: string[];
  analysis: Analysis;
  judgement?: Judgement;
  annotation?: Annotation;
  body: string;
};

export function verifyMigration(text: string, context: VerifyContext): Verification {
  const parsed = parseAnnotation(text);
  const analysis = analyze(parsed.body);
  const problems = [...analysis.problems];
  const result: Verification = {
    problems,
    analysis,
    annotation: parsed.annotation,
    body: parsed.body,
  };
  if (!analysis.highRisk) return result;

  const fail = (message: string) => problems.push(`${message}; ${REMEDY(context.file)}`);
  const why = analysis.risky
    .map((effect) => `line ${effect.line} ${effect.label} (${effect.why})`)
    .join("; ");
  const annotation = parsed.annotation;
  const hash = sha256(parsed.body);
  if (!parsed.present) fail(`high-risk statements need a safety annotation: ${why}`);
  else if (!annotation) fail(`the safety annotation is not valid: ${parsed.error}`);
  else if (annotation.bodySha256 !== hash)
    fail("the migration was edited after its safety annotation was written");
  else if (annotation.pg !== PG_VERSION)
    fail(`the annotation was made for PostgreSQL ${annotation.pg}, not ${PG_VERSION}`);
  if (!annotation || annotation.bodySha256 !== hash) return result;

  // What needs no snapshot: the annotation names the statements the migration actually has, and
  // its verdict does not contradict the locks they take.
  if (annotation.verdict === "rewrite")
    fail("its verdict is rewrite: it must not be applied as written");
  if (annotation.verdict === "ok" && analysis.needsLockTimeout)
    fail("the annotation says ok, but the migration takes blocking locks");
  // The lines name statements and locks, not sizes, so no catalog is needed to compare them.
  if (keys(judge(analysis, new Map(), new Set()).lines) !== keys(annotation.tables))
    fail("the annotation does not describe the migration's statements");

  const catalog = context.catalog?.();
  if (!catalog) {
    if (context.requireCatalog)
      fail("no catalog snapshot is available to judge the table sizes, so the check fails closed");
    return result;
  }
  const { snapshot, tables } = catalog;
  if (snapshot) {
    const age = snapshotAgeDays(snapshot, context.now);
    if (age > MAX_SNAPSHOT_AGE_DAYS)
      fail(
        `the ${snapshot.environment} catalog snapshot is ${Math.floor(age)} days old (at most ${MAX_SNAPSHOT_AGE_DAYS} days), so it no longer shows the table sizes`,
      );
  }
  const judgement = judge(analysis, tables, context.createdElsewhere());
  result.judgement = judgement;
  if (judgement.verdict === "rewrite")
    fail(
      `it must be rewritten: ${judgement.rewrites.map((effect) => `line ${effect.line} ${effect.label} locks or scans ${effect.table ?? "a table"}, which is large (or its size is unknown)`).join("; ")}`,
    );
  else if (judgement.verdict !== annotation.verdict)
    fail(
      `the annotation says ${annotation.verdict}, but the table sizes now give ${judgement.verdict}`,
    );
  else if (keys(judgement.lines) !== keys(annotation.tables))
    fail("the annotation's locks or rewrites differ from the recomputation");
  return result;
}
