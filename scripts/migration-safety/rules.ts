// The rules of the migration safety check. `analyze` needs only the SQL: which statements are high
// risk (on a table that predates the migration) and whether the migration sets a usable
// lock_timeout where it must. `judge` adds a catalog and gives the verdict.
import { classify } from "./classify";
import { BLOCKING, type Classified, type Effect, type Lock, unknownEffect } from "./effects";
import { type Catalog, isLarge, type TableStat } from "./snapshot";
import { splitStatements, SqlSyntaxError } from "./tokenize";

export type Verdict = "ok" | "ok-with-lock-timeout" | "rewrite";

/** The longest lock_timeout a migration may set: a lock queue that long is the most it may cause. */
export const MAX_LOCK_TIMEOUT_MS = 10_000;

export type Risk = Effect & { line: number };
export type Analysis = {
  /** The high-risk effects: those on tables that existed before this migration. */
  risky: Risk[];
  /** Tables the migration creates, in the order it creates them. */
  creates: string[];
  /** Structural problems, each worded with what to do. */
  problems: string[];
  highRisk: boolean;
  /** Some high-risk effect takes a lock that makes others wait, so a lock_timeout must guard it. */
  needsLockTimeout: boolean;
};

/** Tables a migration's SQL creates: used to tell a table the next migrations see from one in use. */
export function createdTables(sql: string): string[] {
  try {
    return splitStatements(sql).flatMap((statement) => classify(statement).creates);
  } catch (error) {
    if (error instanceof SqlSyntaxError) return [];
    throw error;
  }
}

/** A statement that takes a blocking lock on a table that exists (or on one we cannot name). */
const needsGuard = (effect: Effect, created: string[]) =>
  BLOCKING.has(effect.lock) && !(effect.table !== undefined && created.includes(effect.table));

export function analyze(sql: string): Analysis {
  const problems: string[] = [];
  let statements: Classified[] = [];
  try {
    statements = splitStatements(sql).map(classify);
  } catch (error) {
    if (!(error instanceof SqlSyntaxError)) throw error;
    problems.push(`the SQL cannot be read: ${error.message}`);
    return {
      risky: [{ ...unknownEffect([], "unparseable SQL"), line: 1 }],
      creates: [],
      problems,
      highRisk: true,
      needsLockTimeout: true,
    };
  }

  const risky: Risk[] = [];
  const creates: string[] = [];
  // The lock_timeout in force: undefined is the default, which is no timeout.
  let timeoutMs: number | undefined;
  let sawLocal = false;
  let setsTimeout = false;
  const unguarded: Risk[] = [];
  for (const statement of statements) {
    const setting = statement.lockTimeout;
    if (setting?.local) sawLocal = true;
    else if (setting) {
      timeoutMs = setting.ms;
      setsTimeout ||= setting.ms !== undefined;
    }
    for (const effect of statement.effects) {
      // A table created earlier in this migration is empty and unseen by running code.
      const fresh = effect.table !== undefined && creates.includes(effect.table);
      const found = { ...effect, line: statement.line };
      if (effect.high && !fresh) risky.push(found);
      const guarded = timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= MAX_LOCK_TIMEOUT_MS;
      if (needsGuard(effect, creates) && !guarded) unguarded.push(found);
    }
    // Anything unrecognised may change lock_timeout (set_config, a DO block, ALTER ROLE ... SET).
    if (statement.effects.some((effect) => effect.unknown)) timeoutMs = undefined;
    creates.push(...statement.creates);
  }

  const needsLockTimeout = risky.some((effect) => BLOCKING.has(effect.lock));
  if (unguarded.length > 0) {
    const what = unguarded
      .map(
        (effect) =>
          `line ${effect.line} ${effect.label}${effect.table ? ` on ${effect.table}` : ""} (${effect.lock})`,
      )
      .join("; ");
    problems.push(
      `${what}: takes a blocking lock without a lock_timeout of at most ${MAX_LOCK_TIMEOUT_MS / 1000}s in force, so it would wait for the lock indefinitely. Put \`SET lock_timeout = '5s';\` before it and \`RESET lock_timeout;\` after it` +
        (sawLocal
          ? " (a `SET LOCAL lock_timeout` does not count: Prisma runs a migration file outside a transaction block, so LOCAL has no effect)"
          : "") +
        ".",
    );
  }
  const last = statements.at(-1);
  const resets = last !== undefined && isReset(last);
  if (setsTimeout && !resets)
    problems.push(
      "the migration sets lock_timeout but does not end with `RESET lock_timeout;`, which would leave the timeout on the connection for the migration files that follow.",
    );
  if (needsLockTimeout && setsTimeout && !isolated(statements))
    problems.push(
      "a high-risk statement guarded by lock_timeout must be alone in its file: `migrate deploy` runs a file without a transaction, so if the timeout fires anything else in the file is left half applied. Split the file so this one contains only `SET lock_timeout = '5s';`, the one high-risk statement, and `RESET lock_timeout;`.",
    );
  const concurrent = statements.filter((statement) => statement.concurrently);
  if (concurrent.length > 0 && statements.length > 1)
    problems.push(
      `line ${concurrent[0]!.line}: CREATE/DROP INDEX CONCURRENTLY must be the only statement of its migration file (it cannot run in a transaction or alongside other statements); move it to a migration of its own.`,
    );
  return { risky, creates, problems, highRisk: risky.length > 0, needsLockTimeout };
}

const isReset = (statement: Classified) => statement.lockTimeout?.reset === true;

/** Exactly `SET lock_timeout`, one statement, `RESET lock_timeout`. */
function isolated(statements: Classified[]): boolean {
  const [set, , reset] = statements;
  const timeout = set?.lockTimeout;
  return (
    statements.length === 3 &&
    timeout !== undefined &&
    !timeout.local &&
    timeout.ms !== undefined &&
    isReset(reset!)
  );
}

export type TableLine = {
  table: string;
  rows: number;
  bytes: number;
  lock: Lock;
  /** The statement rewrites or scans the whole table (whatever its size). */
  rewrite: boolean;
  statement: string;
};

export type Judgement = { verdict: Verdict; lines: TableLine[]; rewrites: Risk[] };

type Size = Pick<TableStat, "approxRows" | "totalBytes">;
const EMPTY: Size = { approxRows: 0, totalBytes: 0 };
const UNKNOWN: Size = { approxRows: -1, totalBytes: -1 };

/**
 * The verdict for `analysis` against `catalog`. A table the catalog lacks is empty when another
 * migration creates it (`createdElsewhere`: it is not deployed yet), and unknown, so large, if none
 * does. An unrecognised statement is as large as the largest catalog table it names, and large
 * when it names none.
 */
export function judge(
  analysis: Analysis,
  catalog: Catalog,
  createdElsewhere: ReadonlySet<string>,
): Judgement {
  const statFor = (effect: Risk): { stat: Size; large: boolean } => {
    if (effect.unknown) {
      const named = [...catalog.values()].filter((entry) => effect.mentions?.includes(entry.name));
      const largest = named.find(isLarge) ?? named[0];
      return { stat: largest ?? UNKNOWN, large: largest === undefined || isLarge(largest) };
    }
    const known = catalog.get(effect.table!);
    // Tables the statement reads count as much as the one it writes.
    const read = [...catalog.values()].filter((entry) => effect.mentions?.includes(entry.name));
    const biggest = read.find(isLarge);
    if (biggest) return { stat: biggest, large: true };
    if (known) return { stat: known, large: isLarge(known) };
    return createdElsewhere.has(effect.table!)
      ? { stat: EMPTY, large: false }
      : { stat: UNKNOWN, large: true };
  };
  const lines: TableLine[] = [];
  const rewrites: Risk[] = [];
  for (const effect of analysis.risky) {
    const { stat, large } = statFor(effect);
    lines.push({
      table: effect.table ?? "*",
      rows: stat.approxRows,
      bytes: stat.totalBytes,
      lock: effect.lock,
      rewrite: effect.scans,
      statement: effect.label,
    });
    if (effect.scans && large) rewrites.push(effect);
  }
  const verdict: Verdict =
    rewrites.length > 0 ? "rewrite" : analysis.needsLockTimeout ? "ok-with-lock-timeout" : "ok";
  return { verdict, lines, rewrites };
}
