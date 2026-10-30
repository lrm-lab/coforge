// The annotation at the top of a checked migration file: what the check concluded, from which
// snapshot, and a hash of the body below it. Comments only: SQL, Prisma and the checker's own
// tokenizer all ignore it.
//
//   -- migration-safety v1
//   -- checked: 2026-10-31T03:00:00.000Z  pg: 18.0  verdict: ok-with-lock-timeout
//   -- snapshot: 2026-10-31T02:00:00.000Z production
//   -- body-sha256: <hex>
//   -- table: "tasks" rows≈1200 size=3251200 lock=access-exclusive rewrite=no statement=ALTER TABLE SET NOT NULL
import { createHash } from "node:crypto";
import type { Lock } from "./effects";
import type { TableLine, Verdict } from "./rules";

export const PG_VERSION = "18.0";
const HEADER = "-- migration-safety v1";
const BLOCK_LINE = /^-- (?:checked|snapshot|body-sha256|table): /;
const VERDICTS: readonly string[] = ["ok", "ok-with-lock-timeout", "rewrite"];

export type Annotation = {
  checked: string;
  pg: string;
  verdict: Verdict;
  snapshotAt: string;
  snapshotEnvironment: string;
  bodySha256: string;
  tables: TableLine[];
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The annotation block, if the file starts with one, and the body that follows it. */
export function split(text: string): { block: string[]; body: string } {
  if (!text.startsWith(`${HEADER}\n`)) return { block: [], body: text };
  const lines = text.split("\n");
  let end = 1;
  while (end < lines.length && BLOCK_LINE.test(lines[end]!)) end++;
  return { block: lines.slice(0, end), body: lines.slice(end).join("\n") };
}

/** Whether `text` starts with the annotation marker, and the annotation if it is well formed. */
export function parseAnnotation(text: string): {
  present: boolean;
  annotation?: Annotation;
  error?: string;
  body: string;
} {
  const { block, body } = split(text);
  if (block.length === 0)
    return {
      present: text.startsWith("-- migration-safety"),
      body,
      error: text.startsWith("-- migration-safety")
        ? `the first line must be exactly "${HEADER}"`
        : undefined,
    };
  const fail = (error: string) => ({ present: true, error, body });
  const checked = /^-- checked: (\S+)  pg: (\S+)  verdict: (\S+)$/.exec(block[1] ?? "");
  const snapshot = /^-- snapshot: (\S+) (\S+)$/.exec(block[2] ?? "");
  const hash = /^-- body-sha256: ([0-9a-f]{64})$/.exec(block[3] ?? "");
  if (!checked || !snapshot || !hash)
    return fail("the annotation lines are missing or out of order");
  if (Number.isNaN(Date.parse(checked[1]!)) || Number.isNaN(Date.parse(snapshot[1]!)))
    return fail("an annotation time is not a date");
  if (!VERDICTS.includes(checked[3]!))
    return fail(`verdict "${checked[3]}" is not one of ${VERDICTS.join(", ")}`);
  const tables: TableLine[] = [];
  for (const line of block.slice(4)) {
    const match =
      /^-- table: ("(?:[^"\\]|\\.)*") rows≈(-?\d+) size=(-?\d+) lock=(\S+) rewrite=(yes|no) statement=(.+)$/.exec(
        line,
      );
    if (!match) return fail(`malformed table line: ${line}`);
    tables.push({
      table: JSON.parse(match[1]!) as string,
      rows: Number(match[2]),
      bytes: Number(match[3]),
      lock: match[4] as Lock,
      rewrite: match[5] === "yes",
      statement: match[6]!,
    });
  }
  return {
    present: true,
    body,
    annotation: {
      checked: checked[1]!,
      pg: checked[2]!,
      verdict: checked[3] as Verdict,
      snapshotAt: snapshot[1]!,
      snapshotEnvironment: snapshot[2]!,
      bodySha256: hash[1]!,
      tables,
    },
  };
}

export function formatAnnotation(annotation: Omit<Annotation, "bodySha256">, body: string): string {
  const lines = [
    HEADER,
    `-- checked: ${annotation.checked}  pg: ${annotation.pg}  verdict: ${annotation.verdict}`,
    `-- snapshot: ${annotation.snapshotAt} ${annotation.snapshotEnvironment}`,
    `-- body-sha256: ${sha256(body)}`,
    ...annotation.tables.map(
      (line) =>
        `-- table: ${JSON.stringify(line.table)} rows≈${line.rows} size=${line.bytes} lock=${line.lock} rewrite=${line.rewrite ? "yes" : "no"} statement=${line.statement}`,
    ),
  ];
  return `${lines.join("\n")}\n${body}`;
}

/** The part of a table line that must agree with a recomputation; rows and size may drift. */
const lineKey = (line: TableLine) => `${line.table}|${line.lock}|${line.rewrite}|${line.statement}`;

/** The lines as one comparable string, in any order. */
export const keys = (lines: TableLine[]) => lines.map(lineKey).sort().join("\n");
