// ALTER TABLE: each comma-separated action is classified on its own (see classify.ts).
import {
  type Effect,
  hasSequence,
  isName,
  type Lock,
  readName,
  skip,
  splitTopLevel,
  topLevel,
  unknownEffect,
} from "./effects";
import { keyword, type Token } from "./tokenize";

// Functions whose value is fixed when the ALTER runs, so a DEFAULT using them does not rewrite the
// table (PostgreSQL 11+: only a volatile default does). Anything else is assumed volatile.
const STABLE_DEFAULTS = new Set([
  "now",
  "current_timestamp",
  "current_date",
  "current_time",
  "localtime",
  "localtimestamp",
  "transaction_timestamp",
  "statement_timestamp",
  "current_user",
  "session_user",
]);

/** Whether a DEFAULT expression is volatile: it calls any function outside STABLE_DEFAULTS, by a
 * plain, quoted or schema-qualified name. A cast's type name (`::varchar(10)`, `AS varchar(10)`)
 * is not a call. */
function volatileDefault(expression: Token[]): boolean {
  return expression.some((token, at) => {
    if (token.kind !== "word" && token.kind !== "ident") return false;
    const next = expression[at + 1];
    const call = next?.kind === "punct" && next.text === "(";
    const lower = token.text.toLowerCase();
    const before = expression[at - 1];
    if (before?.text === "::" || keyword(before) === "AS") return false;
    if (call)
      return (
        token.kind === "ident" ||
        (!["array", "cast", "row"].includes(lower) && !STABLE_DEFAULTS.has(lower))
      );
    return (
      token.kind === "word" &&
      /^(nextval|random|gen_random_uuid|clock_timestamp|uuid_generate_v\d)$/.test(lower)
    );
  });
}

/** What one ALTER TABLE action does; alterTable adds the table. */
type Action = Omit<Effect, "table">;

/** High risk: rewrites or scans the whole table. */
const rewrite = (label: string, why: string, lock: Lock = "access-exclusive"): Action => ({
  label,
  lock,
  scans: true,
  high: true,
  why,
});
/** High risk without a scan: only the lock, or the damage to running code. */
const strict = (label: string, why: string): Action => ({
  label,
  lock: "access-exclusive",
  scans: false,
  high: true,
  why,
});
const quiet = (label: string, lock: Lock, scans = false): Action => ({
  label,
  lock,
  scans,
  high: false,
});

const SERIAL = /^(small|big)?serial$|^serial[248]$/i;

const COLUMN_CLAUSES = new Set([
  "NOT",
  "NULL",
  "CONSTRAINT",
  "CHECK",
  "REFERENCES",
  "PRIMARY",
  "UNIQUE",
  "GENERATED",
  "COLLATE",
  "DEFAULT",
]);

/** ADD COLUMN: `rest` follows the column name. */
function addColumn(rest: Token[]): Action {
  const top = topLevel(rest);
  const clause = (word: string) => top.find(({ token }) => keyword(token) === word);
  const defaultAt = clause("DEFAULT");
  let expression: Token[] = [];
  if (defaultAt) {
    const after = rest.slice(defaultAt.index + 1);
    const stop = topLevel(after).find(({ token }) => COLUMN_CLAUSES.has(keyword(token) ?? ""));
    expression = stop ? after.slice(0, stop.index) : after;
  }
  const label = "ALTER TABLE ADD COLUMN";
  if (rest[0]?.kind === "word" && SERIAL.test(rest[0].text))
    return rewrite(
      label,
      "a serial column takes nextval() as its default and NOT NULL, which rewrites the table",
    );
  if (clause("GENERATED"))
    return rewrite(label, "a generated or identity column is computed for every existing row");
  if (defaultAt && volatileDefault(expression))
    return rewrite(label, "a volatile DEFAULT rewrites the whole table");
  if (hasSequence(rest, "NOT", "NULL") && !defaultAt)
    return strict(label, "NOT NULL without a DEFAULT cannot be added to a table that has rows");
  if (clause("PRIMARY") || clause("UNIQUE") || clause("REFERENCES") || clause("CHECK"))
    return rewrite(label, "a constraint on the new column is validated against every row");
  return quiet(label, "access-exclusive");
}

/** ADD [CONSTRAINT name] <kind> ...; `rest` follows ADD. */
function addConstraint(rest: Token[]): Action {
  const from = keyword(rest[0]) === "CONSTRAINT" ? 2 : 0;
  const kind = keyword(rest[from]) === "PRIMARY" ? "PRIMARY KEY" : keyword(rest[from]);
  const notValid = hasSequence(rest, "NOT", "VALID");
  const usingIndex = hasSequence(rest, "USING", "INDEX");
  const label = `ALTER TABLE ADD ${kind === "FOREIGN" ? "FOREIGN KEY" : kind}`;
  const why = `${label.slice(12)} validates or indexes every row while the table is locked`;
  switch (kind) {
    case "UNIQUE":
      return usingIndex ? quiet(label, "access-exclusive") : rewrite(label, why);
    case "FOREIGN":
      return notValid
        ? quiet(label, "share-row-exclusive")
        : rewrite(label, why, "share-row-exclusive");
    case "CHECK":
      return notValid ? quiet(label, "access-exclusive") : rewrite(label, why);
    default:
      return rewrite(label, why);
  }
}

// ALTER COLUMN operations that change a catalog entry and touch no row.
const QUICK_COLUMN_OPS = [
  ["DROP", "NOT", "NULL"],
  ["SET", "DEFAULT"],
  ["DROP", "DEFAULT"],
  ["SET", "STATISTICS"],
  ["SET", "STORAGE"],
  ["SET", "COMPRESSION"],
  ["DROP", "IDENTITY"],
  ["DROP", "EXPRESSION"],
  ["SET", "GENERATED"],
  ["ADD", "GENERATED"],
];

/** One comma-separated action of ALTER TABLE. */
function alterAction(action: Token[]): Action {
  const [first, second] = [keyword(action[0]), keyword(action[1])];
  const word = (index: number) => keyword(action[index]);
  if (first === "ADD") {
    if (["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE"].includes(second ?? ""))
      return addConstraint(action.slice(1));
    const column = readName(action, skip(action, 1, ["COLUMN"], ["IF", "NOT", "EXISTS"]));
    if (column) return addColumn(action.slice(column.end));
  }
  if (first === "DROP" && second === "CONSTRAINT")
    return strict(
      "ALTER TABLE DROP CONSTRAINT",
      "dropping a constraint locks the table and can break running code",
    );
  if (first === "DROP" && (second === "COLUMN" || isName(action[1])))
    return strict(
      "ALTER TABLE DROP COLUMN",
      "dropping a column breaks running code that still reads it",
    );
  if (first === "ALTER") {
    const column = readName(action, skip(action, 1, ["COLUMN"]));
    if (column) {
      const op = column.end;
      if (
        word(op) === "TYPE" ||
        (word(op) === "SET" && word(op + 1) === "DATA" && word(op + 2) === "TYPE")
      )
        return rewrite("ALTER TABLE ALTER COLUMN TYPE", "a type change rewrites the whole table");
      if (word(op) === "SET" && word(op + 1) === "NOT" && word(op + 2) === "NULL")
        return rewrite(
          "ALTER TABLE SET NOT NULL",
          "SET NOT NULL scans every row while the table is locked",
        );
      if (QUICK_COLUMN_OPS.some((words) => words.every((w, n) => word(op + n) === w)))
        return quiet(`ALTER TABLE ALTER COLUMN ${word(op)} ${word(op + 1)}`, "access-exclusive");
    }
  }
  if (first === "VALIDATE" && second === "CONSTRAINT")
    return quiet("ALTER TABLE VALIDATE CONSTRAINT", "share-update-exclusive", true);
  if (first === "RENAME") {
    if (second === "CONSTRAINT") return quiet("ALTER TABLE RENAME CONSTRAINT", "access-exclusive");
    return strict("ALTER TABLE RENAME", "renaming breaks running code that uses the old name");
  }
  if (first === "OWNER" && second === "TO") return quiet("ALTER TABLE OWNER", "access-exclusive");
  if (
    (first === "ENABLE" || first === "DISABLE") &&
    ["TRIGGER", "RULE", "ROW"].includes(second ?? "")
  )
    return quiet("ALTER TABLE ENABLE/DISABLE", "share-row-exclusive");
  if (first === "SET" && action[1]?.text === "(")
    return quiet("ALTER TABLE SET options", "share-update-exclusive");
  if (first === "RESET" && action[1]?.text === "(")
    return quiet("ALTER TABLE RESET options", "share-update-exclusive");
  return unknownEffect(action, "unrecognised ALTER TABLE action");
}

export function alterTable(tokens: Token[]): Effect[] {
  const at = skip(tokens, 2, ["IF", "EXISTS"], ["ONLY"]);
  const table = readName(tokens, at);
  if (!table) return [unknownEffect(tokens)];
  const actions = splitTopLevel(
    tokens.slice(table.end).filter((token) => !(token.kind === "punct" && token.text === "*")),
  );
  return actions.map((action) => {
    const effect = alterAction(action);
    // An unrecognised action is as large as the table it names (and whatever else the text names).
    return effect.unknown ? unknownEffect(tokens, effect.label) : { ...effect, table: table.name };
  });
}
