// Classifies one SQL statement by what it does to a table under PostgreSQL 18: the lock it takes,
// whether it rewrites or scans the whole table, and whether that makes it high risk on a table that
// already holds data. A statement this file does not recognise is high risk (it may do anything).
// Whether a high-risk effect is judged at all (the table must predate the migration) and what the
// verdict is (the table's size) belong to rules.ts.
import { alterTable } from "./alter-table";
import {
  type Classified,
  hasSequence,
  isName,
  type Effect,
  high,
  type Lock,
  type LockTimeoutSetting,
  low,
  readName,
  skip,
  topLevel,
  unknownEffect,
} from "./effects";
import { keyword, type Statement, type Token } from "./tokenize";

function createIndex(tokens: Token[], from: number): { effects: Effect[]; concurrently: boolean } {
  let at = skip(tokens, from, ["UNIQUE"]);
  if (keyword(tokens[at]) !== "INDEX")
    return { effects: [unknownEffect(tokens)], concurrently: false };
  at++;
  const concurrently = keyword(tokens[at]) === "CONCURRENTLY";
  at = skip(tokens, at, ["CONCURRENTLY"], ["IF", "NOT", "EXISTS"]);
  if (keyword(tokens[at]) !== "ON") at = readName(tokens, at)?.end ?? at;
  const table =
    keyword(tokens[at]) === "ON" ? readName(tokens, skip(tokens, at + 1, ["ONLY"])) : undefined;
  if (!table) return { effects: [unknownEffect(tokens)], concurrently };
  const effect = concurrently
    ? low("CREATE INDEX CONCURRENTLY", table.name, "share-update-exclusive", true)
    : high(
        "CREATE INDEX",
        table.name,
        "an index build scans the whole table and blocks writes meanwhile",
        "share",
        true,
      );
  return { effects: [effect], concurrently };
}

const LOCK_MODES: Record<string, Lock> = {
  "ACCESS SHARE": "none",
  "ROW SHARE": "none",
  "ROW EXCLUSIVE": "row-exclusive",
  "SHARE UPDATE EXCLUSIVE": "share-update-exclusive",
  SHARE: "share",
  "SHARE ROW EXCLUSIVE": "share-row-exclusive",
  EXCLUSIVE: "exclusive",
  "ACCESS EXCLUSIVE": "access-exclusive",
};

/** A comma-separated list of table names starting at `from`, ending at the first non-name. */
function tableList(tokens: Token[], from: number): string[] {
  const names: string[] = [];
  let at = from;
  for (;;) {
    const name = readName(tokens, at);
    if (!name) return names;
    names.push(name.name);
    at = skip(tokens, name.end, ["*"]);
    if (tokens[at]?.text !== ",") return names;
    at++;
  }
}

const LOW_DROPS = new Set(["TYPE", "SEQUENCE", "VIEW", "FUNCTION", "PROCEDURE", "DOMAIN"]);
const LOW_CREATES = new Set([
  "TYPE",
  "EXTENSION",
  "SEQUENCE",
  "SCHEMA",
  "FUNCTION",
  "PROCEDURE",
  "VIEW",
  "DOMAIN",
  "MATERIALIZED",
  "COLLATION",
  "AGGREGATE",
  "OPERATOR",
]);
const LOW_ALTERS = new Set([
  "TYPE",
  "SEQUENCE",
  "INDEX",
  "EXTENSION",
  "FUNCTION",
  "VIEW",
  "DOMAIN",
  "SCHEMA",
]);

/** Whether a UPDATE/DELETE has a WHERE that limits it: a missing or trivially true one (`true`,
 * `(true)`, `1 = 1`) does not. */
function limited(tokens: Token[]): boolean {
  const where = topLevel(tokens).find(({ token }) => keyword(token) === "WHERE");
  if (!where) return false;
  const condition = tokens
    .slice(where.index + 1)
    .map((token) => token.text.toLowerCase())
    .filter((text) => text !== "(" && text !== ")")
    .join("");
  return !(condition === "true" || condition === "1=1");
}

const NOT_AN_ALIAS = new Set([
  "WHERE",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "ON",
  "USING",
  "GROUP",
  "ORDER",
  "LIMIT",
  "SET",
  "RETURNING",
  "UNION",
  "HAVING",
  "WINDOW",
]);

/** The effect, with the names of the other tables the statement reads (after FROM, JOIN, USING):
 * it scans them too, so the verdict looks at the largest of them and the target. */
function withSources(effect: Effect, tokens: Token[]): Effect {
  const sources: string[] = [];
  tokens.forEach((token, at) => {
    if (!["FROM", "JOIN", "USING"].includes(keyword(token) ?? "")) return;
    // A comma-separated list, each table optionally followed by an alias.
    for (let i = at + 1; ;) {
      const name = readName(tokens, i);
      if (!name) break;
      sources.push(name.name.split(".").pop()!);
      i = skip(tokens, name.end, ["AS"]);
      if (isName(tokens[i]) && !NOT_AN_ALIAS.has(keyword(tokens[i]) ?? "")) i++;
      if (tokens[i]?.text !== ",") break;
      i++;
    }
  });
  return { ...effect, mentions: sources };
}

/** UPDATE and DELETE touch rows in proportion to the table: a WHERE does not make a big table
 * safe, so both are judged against the table's size (and need an annotation to be). */
function rowChange(verb: string, table: string, bounded: boolean, tokens: Token[]): Effect {
  return withSources(
    high(
      bounded ? verb : `${verb} without WHERE`,
      table,
      bounded
        ? `${verb} touches rows in proportion to the table, so its size decides whether it is safe`
        : `${verb} with no WHERE touches every row`,
      "row-exclusive",
      true,
    ),
    tokens,
  );
}

const LOCK_TIMEOUT_VALUE = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/;
const UNIT_MS: Record<string, number> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `SET [SESSION | LOCAL] lock_timeout { TO | = } value`, or undefined if it is another SET. */
function lockTimeoutOf(tokens: Token[]): LockTimeoutSetting | undefined {
  const at = skip(tokens, 1, ["SESSION"]);
  const local = keyword(tokens[at]) === "LOCAL";
  const nameAt = local ? at + 1 : at;
  if (tokens[nameAt]?.text.toLowerCase() !== "lock_timeout") return undefined;
  const value = tokens[nameAt + 2];
  const separator = keyword(tokens[nameAt + 1]) === "TO" || tokens[nameAt + 1]?.text === "=";
  const match =
    value && (value.kind === "string" || value.kind === "number")
      ? LOCK_TIMEOUT_VALUE.exec(value.text)
      : null;
  const single = separator && tokens.length === nameAt + 3;
  return { local, ms: match && single ? Number(match[1]) * UNIT_MS[match[2] ?? "ms"]! : undefined };
}

/** What CREATE TABLE does to the tables it points at: a foreign key takes SHARE ROW EXCLUSIVE on
 * the referenced table, a partition takes ACCESS EXCLUSIVE on its parent. */
function tableLinks(tokens: Token[], from: number): Effect[] {
  const links: Effect[] = [];
  tokens.forEach((token, at) => {
    if (at < from) return;
    const word = keyword(token);
    if (word === "REFERENCES") {
      const target = readName(tokens, at + 1);
      if (target) links.push(low("CREATE TABLE REFERENCES", target.name, "share-row-exclusive"));
    } else if (word === "PARTITION" && keyword(tokens[at + 1]) === "OF") {
      const parent = readName(tokens, at + 2);
      if (parent) links.push(low("CREATE TABLE PARTITION OF", parent.name, "access-exclusive"));
    }
  });
  return links;
}

export function classify(statement: Statement): Classified {
  const { tokens } = statement;
  const result: Classified = {
    line: statement.line,
    effects: [],
    creates: [],
    concurrently: false,
  };
  const [first, second] = [keyword(tokens[0]), keyword(tokens[1])];
  const done = (effects: Effect[]) => ({ ...result, effects });

  if (first === "SET" || first === "RESET" || first === "SHOW") {
    if (first === "SET") result.lockTimeout = lockTimeoutOf(tokens);
    // RESET lock_timeout (or RESET ALL) puts the default, no timeout, back.
    else if (
      first === "RESET" &&
      ["lock_timeout", "all"].includes(tokens[1]?.text.toLowerCase() ?? "")
    )
      result.lockTimeout = { local: false, reset: true };
    return done([low(first, undefined)]);
  }
  if (first === "ALTER" && second === "TABLE") return done(alterTable(tokens));
  if (first === "ALTER" && second === "DOMAIN") {
    // A domain constraint is checked against every column that uses the domain, in tables we cannot name.
    const checks =
      tokens.some((token) => ["ADD", "VALIDATE"].includes(keyword(token) ?? "")) ||
      hasSequence(tokens, "SET", "NOT", "NULL");
    return done([
      checks ? unknownEffect(tokens, "ALTER DOMAIN constraint") : low("ALTER DOMAIN", undefined),
    ]);
  }
  if (first === "ALTER" && second === "INDEX" && hasSequence(tokens, "SET", "TABLESPACE"))
    return done([unknownEffect(tokens, "ALTER INDEX SET TABLESPACE")]);
  if (first === "ALTER" && LOW_ALTERS.has(second ?? ""))
    return done([low(`ALTER ${second}`, undefined)]);
  if (first === "CREATE") {
    const at = skip(
      tokens,
      1,
      ["OR", "REPLACE"],
      ["GLOBAL"],
      ["LOCAL"],
      ["TEMPORARY"],
      ["TEMP"],
      ["UNLOGGED"],
    );
    const temporary = tokens
      .slice(1, at)
      .some((token) => ["TEMP", "TEMPORARY"].includes(keyword(token) ?? ""));
    const kind = keyword(tokens[at]);
    if (kind === "TABLE") {
      const exists = skip(tokens, at + 1, ["IF", "NOT", "EXISTS"]);
      const name = readName(tokens, exists);
      // IF NOT EXISTS may find the table already there, so it does not make the table new.
      if (name && !temporary && exists === at + 1) result.creates.push(name.name);
      return done([low("CREATE TABLE", name?.name), ...tableLinks(tokens, name?.end ?? at + 1)]);
    }
    if (kind === "INDEX" || kind === "UNIQUE") {
      const index = createIndex(tokens, at);
      result.concurrently = index.concurrently;
      return done(index.effects);
    }
    if (LOW_CREATES.has(kind ?? "")) return done([low(`CREATE ${kind}`, undefined)]);
  }
  if (first === "DROP") {
    const cascade = tokens.some((token) => keyword(token) === "CASCADE");
    if (second === "TABLE") {
      const names = tableList(tokens, skip(tokens, 2, ["IF", "EXISTS"]));
      if (names.length > 0)
        return done(
          names
            .map((name) =>
              high("DROP TABLE", name, "dropping a table breaks running code that uses it"),
            )
            .concat(cascade ? [unknownEffect(tokens, "DROP TABLE CASCADE")] : []),
        );
    } else if (second === "INDEX") {
      result.concurrently = keyword(tokens[2]) === "CONCURRENTLY";
      // The CONCURRENTLY form waits only for transactions that use the index, and blocks no one.
      return done([
        low(
          "DROP INDEX",
          undefined,
          result.concurrently ? "share-update-exclusive" : "access-exclusive",
        ),
      ]);
    } else if (LOW_DROPS.has(second ?? "") && !cascade)
      return done([low(`DROP ${second}`, undefined)]);
  }
  if (first === "UPDATE") {
    const table = readName(tokens, skip(tokens, 1, ["ONLY"]));
    if (table) return done([rowChange("UPDATE", table.name, limited(tokens), tokens)]);
  }
  if (first === "DELETE" && second === "FROM") {
    const table = readName(tokens, skip(tokens, 2, ["ONLY"]));
    if (table) return done([rowChange("DELETE", table.name, limited(tokens), tokens)]);
  }
  if (first === "INSERT" && second === "INTO") {
    const table = readName(tokens, 2);
    if (table && tokens.some((token) => keyword(token) === "SELECT"))
      return done([
        withSources(
          high(
            "INSERT SELECT",
            table.name,
            "INSERT ... SELECT copies rows in proportion to the tables it reads",
            "row-exclusive",
            true,
          ),
          tokens,
        ),
      ]);
    if (table) return done([low("INSERT", table.name, "row-exclusive")]);
  }
  if (first === "TRUNCATE") {
    const names = tableList(tokens, skip(tokens, 1, ["TABLE"], ["ONLY"]));
    if (names.length > 0)
      return done(
        names.map((name) =>
          high("TRUNCATE", name, "TRUNCATE empties the table under an exclusive lock"),
        ),
      );
  }
  if (first === "LOCK") {
    const names = tableList(tokens, skip(tokens, 1, ["TABLE"], ["ONLY"]));
    const inAt = tokens.findIndex((token) => keyword(token) === "IN");
    const mode = inAt < 0 ? [] : tokens.slice(inAt + 1).map((token) => token.text.toUpperCase());
    const lock = LOCK_MODES[mode.slice(0, mode.indexOf("MODE")).join(" ")] ?? "access-exclusive";
    if (names.length > 0)
      return done(
        names.map((name) =>
          high("LOCK TABLE", name, "an explicit table lock blocks other sessions", lock),
        ),
      );
  }
  if (first === "COMMENT" && second === "ON") return done([low("COMMENT", undefined)]);
  if (first === "GRANT" || first === "REVOKE") return done([low(first, undefined)]);
  return done([unknownEffect(tokens)]);
}
