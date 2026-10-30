import { describe, expect, test } from "bun:test";
import { formatAnnotation } from "./annotation";
import { analyze, createdTables, judge, type Verdict } from "./rules";
import { catalogOf, type TableStat } from "./snapshot";

const table = (name: string, approxRows: number, totalBytes = 8192): TableStat => ({
  schema: "public",
  name,
  approxRows,
  totalBytes,
});
const catalog = catalogOf({
  tables: [
    table("small", 10),
    table("rows", 100_000),
    table("bytes", 5, 64 * 1024 * 1024),
    table("edge", 99_999, 64 * 1024 * 1024 - 1),
    table("fresh", -1),
    table("freshbig", -1, 900 * 1024 * 1024),
    table("big", 5_000_000, 900 * 1024 * 1024),
  ],
});
const verdictOf = (sql: string, createdElsewhere: string[] = []) =>
  judge(analyze(sql), catalog, new Set(createdElsewhere)).verdict;
/** A statement alone in its file under a lock_timeout, the only shape a guarded one may take. */
const guarded = (statement: string) =>
  `SET lock_timeout = '5s';\n${statement};\nRESET lock_timeout;\n`;

describe("tables created in the same migration", () => {
  test("statements on them are not high risk, and need no lock_timeout", () => {
    const sql =
      'CREATE TABLE "x" (id int);\nALTER TABLE "x" ALTER COLUMN id SET NOT NULL;\nCREATE INDEX i ON x (id);\nUPDATE x SET id = 1;';
    expect(analyze(sql)).toMatchObject({ highRisk: false, problems: [] });
  });

  test("matching ignores case of unquoted names and public.", () => {
    expect(analyze("CREATE TABLE Foo (id int); DROP TABLE public.foo").highRisk).toBe(false);
    expect(analyze('CREATE TABLE "Foo" (id int); DROP TABLE foo').highRisk).toBe(true);
  });

  test("the CREATE TABLE must come before the use", () => {
    expect(analyze("DROP TABLE x; CREATE TABLE x (id int)").highRisk).toBe(true);
  });

  test("CREATE TABLE IF NOT EXISTS does not make the table new", () => {
    expect(analyze("CREATE TABLE IF NOT EXISTS x (id int); DROP TABLE x").highRisk).toBe(true);
  });

  test("createdTables reads annotated text the same as its body", () => {
    const body = "CREATE TABLE a (i int);\n";
    const annotated = formatAnnotation(
      {
        checked: "2026-10-31T00:00:00.000Z",
        pg: "18.0",
        verdict: "ok",
        snapshotAt: "2026-10-31T00:00:00.000Z",
        snapshotEnvironment: "production",
        tables: [],
      },
      body,
    );
    expect(createdTables(annotated)).toEqual(createdTables(body));
  });

  test("createdTables lists them", () => {
    expect(
      createdTables(
        'CREATE TABLE a (i int); CREATE TEMP TABLE t (i int); CREATE TABLE IF NOT EXISTS u (i int); CREATE TABLE "B" (i int)',
      ),
    ).toEqual(["a", "B"]);
  });
});

describe("lock_timeout", () => {
  test.each([
    ["none", "ALTER TABLE small ALTER COLUMN c SET NOT NULL", false],
    ["SET 5s", guarded("ALTER TABLE small ALTER COLUMN c SET NOT NULL"), true],
    ["SET 10s", "SET lock_timeout = '10s';\nDROP TABLE small;\nRESET lock_timeout;", true],
    ["SET 10001ms", "SET lock_timeout = 10001;\nDROP TABLE small;\nRESET lock_timeout;", false],
    ["SET 0", "SET lock_timeout = 0;\nDROP TABLE small;\nRESET lock_timeout;", false],
    [
      "SET LOCAL has no effect under Prisma",
      "SET LOCAL lock_timeout = '5s';\nDROP TABLE small",
      false,
    ],
    ["set after the statement", `DROP TABLE small;\n${guarded("SELECT 1")}`, false],
    [
      "RESET before the statement",
      "SET lock_timeout = '5s';\nRESET lock_timeout;\nDROP TABLE small",
      false,
    ],
    [
      "unreadable value",
      "SET lock_timeout = '5 parsecs';\nDROP TABLE small;\nRESET lock_timeout;",
      false,
    ],
  ])("%s", (_name, sql, accepted) => {
    expect(analyze(sql).problems.length === 0).toBe(accepted);
  });

  test("SET LOCAL's message says why it does not count", () => {
    expect(analyze("SET LOCAL lock_timeout = '5s'; DROP TABLE small").problems.join()).toContain(
      "outside a transaction block",
    );
  });

  test("the message names the statement that needs the timeout", () => {
    const [problem] = analyze("DROP TABLE small").problems;
    expect(problem).toContain("line 1 DROP TABLE on small (access-exclusive)");
  });

  test("a migration that sets a timeout must end with RESET lock_timeout", () => {
    const [problem] = analyze("SET lock_timeout = '5s';\nDROP TABLE small;").problems;
    expect(problem).toContain("does not end with `RESET lock_timeout;`");
    expect(analyze(guarded("DROP TABLE small")).problems).toEqual([]);
  });

  test("statements that take no blocking lock need none", () => {
    expect(analyze("UPDATE small SET a = 1").problems).toEqual([]);
    expect(analyze("CREATE TABLE t (id int); CREATE TYPE e AS ENUM ('a')").problems).toEqual([]);
  });

  test.each([
    ["plain ADD COLUMN", "ALTER TABLE small ADD COLUMN c text"],
    ["DROP INDEX", "DROP INDEX i"],
    [
      "ADD FOREIGN KEY NOT VALID",
      "ALTER TABLE small ADD FOREIGN KEY (a) REFERENCES o (id) NOT VALID",
    ],
    ["ADD CHECK NOT VALID", "ALTER TABLE small ADD CHECK (a > 0) NOT VALID"],
    ["RENAME CONSTRAINT", "ALTER TABLE small RENAME CONSTRAINT a TO b"],
    ["OWNER TO", "ALTER TABLE small OWNER TO someone"],
    ["DISABLE TRIGGER", "ALTER TABLE small DISABLE TRIGGER ALL"],
    ["CREATE TABLE referencing it", "CREATE TABLE n (id int REFERENCES small (id))"],
  ])("a blocking lock that is not high risk still needs a lock_timeout: %s", (_name, sql) => {
    const bare = analyze(sql);
    expect(bare.highRisk).toBe(false);
    expect(bare.problems.join()).toContain("without a lock_timeout");
    expect(analyze(guarded(sql)).problems).toEqual([]);
  });

  test("a low-risk statement guarded among others needs no isolation", () => {
    const sql = `SET lock_timeout = '5s';\nALTER TABLE small ADD COLUMN c text;\nALTER TABLE small ADD COLUMN d text;\nRESET lock_timeout;`;
    expect(analyze(sql).problems).toEqual([]);
  });

  test("an unrecognised statement needs one", () => {
    expect(analyze("DO $$ BEGIN NULL; END $$").problems).toHaveLength(1);
  });

  test.each([
    ["set_config", "SELECT set_config('lock_timeout', '0', false)"],
    ["a DO block", "DO $$ BEGIN SET lock_timeout = 0; END $$"],
    ["ALTER ROLE ... SET", "ALTER ROLE app SET lock_timeout = 0"],
    ["ALTER DATABASE ... SET", "ALTER DATABASE app SET lock_timeout = 0"],
  ])("%s leaves the timeout unguarded for what follows", (_name, change) => {
    const sql = `SET lock_timeout = '5s';\n${change};\nALTER TABLE small ADD COLUMN c text;\nRESET lock_timeout;`;
    expect(analyze(sql).problems.join()).toContain("line 3 ALTER TABLE ADD COLUMN on small");
  });
});

describe("a high-risk statement under a lock_timeout stands alone", () => {
  const risky = "ALTER TABLE small ALTER COLUMN c SET NOT NULL";

  test("exactly SET, the statement, RESET", () => {
    expect(analyze(guarded(risky)).problems).toEqual([]);
  });

  test.each([
    ["another statement before", `CREATE TABLE t (id int);\n${guarded(risky)}`],
    ["another statement after", `${guarded(risky)}CREATE TABLE t (id int);\n`],
    [
      "another statement inside",
      `SET lock_timeout = '5s';\n${risky};\nCREATE TABLE t (id int);\nRESET lock_timeout;`,
    ],
    [
      "two high-risk statements",
      `SET lock_timeout = '5s';\n${risky};\nDROP TABLE small;\nRESET lock_timeout;`,
    ],
  ])("%s is rejected with the way out", (_name, sql) => {
    const problems = analyze(sql).problems.join();
    expect(problems).toContain("must be alone in its file");
    expect(problems).toContain("Split the file");
  });

  test("a high-risk statement that takes no blocking lock is not held to it", () => {
    const sql = `UPDATE small SET a = 1;\nCREATE TABLE t (id int);\n`;
    expect(analyze(sql).problems).toEqual([]);
  });
});

describe("CONCURRENTLY", () => {
  test("alone it is fine", () => {
    expect(analyze("-- c\nCREATE INDEX CONCURRENTLY i ON big (a);\n")).toMatchObject({
      problems: [],
      highRisk: false,
    });
  });
  test.each([
    ["CREATE INDEX CONCURRENTLY i ON big (a); SELECT_X"],
    ["ALTER TABLE a ADD COLUMN b int; DROP INDEX CONCURRENTLY i"],
  ])("mixed with other statements is rejected: %s", (sql) => {
    expect(analyze(sql).problems.join()).toContain("must be the only statement");
  });
});

describe("DROP INDEX CONCURRENTLY", () => {
  test("alone it passes without a lock_timeout, like CREATE INDEX CONCURRENTLY", () => {
    expect(analyze("DROP INDEX CONCURRENTLY IF EXISTS i;\n")).toMatchObject({
      problems: [],
      highRisk: false,
    });
  });

  test("with a lock_timeout around it it is still rejected: it must be alone", () => {
    expect(analyze(guarded("DROP INDEX CONCURRENTLY i")).problems.join()).toContain(
      "must be the only statement",
    );
  });

  test("without CONCURRENTLY it needs the timeout", () => {
    expect(analyze("DROP INDEX i").problems.join()).toContain("without a lock_timeout");
  });
});

describe("statements that read other tables", () => {
  test.each([
    ["INSERT ... SELECT", "INSERT INTO small SELECT * FROM big"],
    ["UPDATE ... FROM", "UPDATE small SET a = b.a FROM big b WHERE b.id = small.id"],
    ["a JOIN", "INSERT INTO small SELECT s.a FROM small s JOIN public.big b ON b.id = s.id"],
    ["a comma list", "INSERT INTO small SELECT 1 FROM small s, big b"],
    ["a subquery", "DELETE FROM small WHERE id IN (SELECT id FROM big)"],
    ["DELETE ... USING", "DELETE FROM small USING big WHERE big.id = small.id"],
  ])("%s is judged by the largest table it reads", (_name, sql) => {
    expect(verdictOf(sql)).toBe("rewrite");
  });

  test("small sources stay small", () => {
    expect(verdictOf("INSERT INTO small SELECT * FROM edge")).toBe("ok");
  });
});

describe("unreadable SQL", () => {
  test("is high risk with a problem", () => {
    const analysis = analyze("ALTER TABLE a ADD COLUMN b text DEFAULT 'oops");
    expect(analysis.highRisk).toBe(true);
    expect(analysis.problems[0]).toContain("unterminated string");
  });
});

describe("verdicts", () => {
  test.each([
    [
      "a small table",
      guarded("ALTER TABLE small ALTER COLUMN c SET NOT NULL"),
      "ok-with-lock-timeout",
    ],
    ["100000 rows", guarded("ALTER TABLE rows ALTER COLUMN c SET NOT NULL"), "rewrite"],
    [
      "99999 rows and under 64 MiB",
      guarded("ALTER TABLE edge ALTER COLUMN c SET NOT NULL"),
      "ok-with-lock-timeout",
    ],
    ["64 MiB", guarded("ALTER TABLE bytes ALTER COLUMN c SET NOT NULL"), "rewrite"],
    [
      "unknown row count and a small size",
      guarded("ALTER TABLE fresh ALTER COLUMN c SET NOT NULL"),
      "ok-with-lock-timeout",
    ],
    [
      "unknown row count and a large size",
      guarded("ALTER TABLE freshbig ALTER COLUMN c SET NOT NULL"),
      "rewrite",
    ],
    [
      "a table the catalog lacks",
      guarded("ALTER TABLE ghost ALTER COLUMN c SET NOT NULL"),
      "rewrite",
    ],
    [
      "a large table, DROP COLUMN (only the lock, no scan)",
      guarded("ALTER TABLE rows DROP COLUMN c"),
      "ok-with-lock-timeout",
    ],
    [
      "a large table, CREATE INDEX",
      "SET lock_timeout = '5s';\nCREATE INDEX i ON rows (a);\nRESET lock_timeout;",
      "rewrite",
    ],
    ["a large table, UPDATE without WHERE", "UPDATE rows SET a = 1", "rewrite"],
    ["a large table, UPDATE with a WHERE", "UPDATE rows SET a = 1 WHERE b IS NULL", "rewrite"],
    ["a large table, DELETE with a WHERE", "DELETE FROM rows WHERE b = 1", "rewrite"],
    ["a large table, INSERT ... SELECT", "INSERT INTO rows (a) SELECT a FROM small", "rewrite"],
    ["a small table, UPDATE with a WHERE", "UPDATE small SET a = 1 WHERE b = 2", "ok"],
    ["a small table, UPDATE without WHERE: no blocking lock", "UPDATE small SET a = 1", "ok"],
    [
      "a large table, safe steps",
      "ALTER TABLE rows ADD CONSTRAINT c CHECK (c > 0) NOT VALID",
      "ok",
    ],
    ["a large table, no high-risk statement", "CREATE INDEX CONCURRENTLY i ON rows (a)", "ok"],
  ])("%s", (_name, sql, expected) => {
    expect(verdictOf(sql)).toBe(expected as Verdict);
  });

  test("a table another migration creates is empty", () => {
    expect(verdictOf(guarded("ALTER TABLE ghost ALTER COLUMN c SET NOT NULL"), ["ghost"])).toBe(
      "ok-with-lock-timeout",
    );
  });

  test.each([
    ["SET UNLOGGED", "ALTER TABLE big SET UNLOGGED"],
    ["SET TABLESPACE", "ALTER TABLE big SET TABLESPACE fast"],
    ["SET EXPRESSION", "ALTER TABLE big ALTER COLUMN g SET EXPRESSION AS (a + 1)"],
    [
      "EXECUTE of a string",
      "DO $$ BEGIN EXECUTE 'ALTER TABLE big ALTER COLUMN a TYPE bigint'; END $$",
    ],
    ["VACUUM FULL", "VACUUM FULL big"],
    ["VACUUM FULL of everything", "VACUUM FULL"],
    ["CLUSTER", "CLUSTER"],
    ["a DO block that names no table", "DO $$ BEGIN NULL; END $$"],
  ])("an unrecognised statement is a rewrite: %s", (_name, statement) => {
    expect(verdictOf(guarded(statement))).toBe("rewrite");
  });

  test("an unrecognised statement naming only small tables is not", () => {
    expect(verdictOf(guarded("DO $$ BEGIN ALTER TABLE small DROP COLUMN c; END $$"))).toBe(
      "ok-with-lock-timeout",
    );
  });

  test.each([
    ["serial", "ALTER TABLE big ADD COLUMN c serial"],
    ["a quoted volatile default", 'ALTER TABLE big ADD COLUMN c uuid DEFAULT "gen_random_uuid"()'],
  ])("ADD COLUMN %s on a large table is a rewrite", (_name, statement) => {
    expect(verdictOf(guarded(statement))).toBe("rewrite");
  });

  test("the lines describe each statement without sizes mattering to their key", () => {
    const { lines } = judge(
      analyze(guarded("ALTER TABLE small DROP COLUMN c")),
      catalog,
      new Set(),
    );
    expect(lines).toEqual([
      {
        table: "small",
        rows: 10,
        bytes: 8192,
        lock: "access-exclusive",
        rewrite: false,
        statement: "ALTER TABLE DROP COLUMN",
      },
    ]);
  });
});
