import { describe, expect, test } from "bun:test";
import { classify } from "./classify";
import { splitStatements } from "./tokenize";

/** `label lock [scans] [high]` for each effect of each statement of `sql`. */
function summarize(sql: string): string[] {
  return splitStatements(sql).flatMap((statement) =>
    classify(statement).effects.map(
      (effect) =>
        `${effect.label} | ${effect.lock}${effect.scans ? " | scans" : ""}${effect.high ? " | HIGH" : ""}`,
    ),
  );
}

describe("high-risk ALTER TABLE", () => {
  test.each([
    [
      "NOT NULL column without a default",
      'ALTER TABLE "t" ADD COLUMN "c" TEXT NOT NULL',
      "ALTER TABLE ADD COLUMN | access-exclusive | HIGH",
    ],
    [
      "volatile default",
      "ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid()",
      "ALTER TABLE ADD COLUMN | access-exclusive | scans | HIGH",
    ],
    [
      "random default",
      "ALTER TABLE t ADD COLUMN c float DEFAULT random()",
      "ALTER TABLE ADD COLUMN | access-exclusive | scans | HIGH",
    ],
    [
      "generated stored column",
      "ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS (a + 1) STORED",
      "ALTER TABLE ADD COLUMN | access-exclusive | scans | HIGH",
    ],
    [
      "unique column",
      "ALTER TABLE t ADD COLUMN c int UNIQUE",
      "ALTER TABLE ADD COLUMN | access-exclusive | scans | HIGH",
    ],
    [
      "type change",
      "ALTER TABLE t ALTER COLUMN c TYPE bigint",
      "ALTER TABLE ALTER COLUMN TYPE | access-exclusive | scans | HIGH",
    ],
    [
      "SET DATA TYPE",
      "ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint",
      "ALTER TABLE ALTER COLUMN TYPE | access-exclusive | scans | HIGH",
    ],
    [
      "SET NOT NULL",
      "ALTER TABLE t ALTER COLUMN c SET NOT NULL",
      "ALTER TABLE SET NOT NULL | access-exclusive | scans | HIGH",
    ],
    [
      "primary key",
      "ALTER TABLE t ADD PRIMARY KEY (id)",
      "ALTER TABLE ADD PRIMARY KEY | access-exclusive | scans | HIGH",
    ],
    [
      "unique constraint",
      "ALTER TABLE t ADD CONSTRAINT u UNIQUE (a)",
      "ALTER TABLE ADD UNIQUE | access-exclusive | scans | HIGH",
    ],
    [
      "foreign key",
      "ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o(id)",
      "ALTER TABLE ADD FOREIGN KEY | share-row-exclusive | scans | HIGH",
    ],
    [
      "check",
      "ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0)",
      "ALTER TABLE ADD CHECK | access-exclusive | scans | HIGH",
    ],
    [
      "drop column",
      "ALTER TABLE t DROP COLUMN c",
      "ALTER TABLE DROP COLUMN | access-exclusive | HIGH",
    ],
    [
      "drop constraint",
      "ALTER TABLE t DROP CONSTRAINT c",
      "ALTER TABLE DROP CONSTRAINT | access-exclusive | HIGH",
    ],
    [
      "rename column",
      "ALTER TABLE t RENAME COLUMN a TO b",
      "ALTER TABLE RENAME | access-exclusive | HIGH",
    ],
    ["rename table", "ALTER TABLE t RENAME TO u", "ALTER TABLE RENAME | access-exclusive | HIGH"],
    ["drop table", "DROP TABLE IF EXISTS a", "DROP TABLE | access-exclusive | HIGH"],
    ["truncate", "TRUNCATE TABLE t RESTART IDENTITY CASCADE", "TRUNCATE | access-exclusive | HIGH"],
    ["lock table", "LOCK TABLE t", "LOCK TABLE | access-exclusive | HIGH"],
    ["lock table in a mode", "LOCK TABLE t IN SHARE MODE", "LOCK TABLE | share | HIGH"],
    [
      "index without CONCURRENTLY",
      "CREATE UNIQUE INDEX i ON t (a)",
      "CREATE INDEX | share | scans | HIGH",
    ],
    [
      "update without WHERE",
      "UPDATE t SET a = 1",
      "UPDATE without WHERE | row-exclusive | scans | HIGH",
    ],
    [
      "update with a trivial WHERE",
      "UPDATE t SET a = 1 WHERE true",
      "UPDATE without WHERE | row-exclusive | scans | HIGH",
    ],
    [
      "WHERE only in a subquery",
      "UPDATE t SET a = (SELECT 1 WHERE true)",
      "UPDATE without WHERE | row-exclusive | scans | HIGH",
    ],
    [
      "delete without WHERE",
      "DELETE FROM t",
      "DELETE without WHERE | row-exclusive | scans | HIGH",
    ],
  ])("%s", (_name, sql, expected) => {
    expect(summarize(sql)).toEqual([expected]);
  });

  test("several actions in one ALTER TABLE are each judged", () => {
    expect(summarize("ALTER TABLE t ADD COLUMN a numeric(10, 2), DROP COLUMN b")).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
      "ALTER TABLE DROP COLUMN | access-exclusive | HIGH",
    ]);
  });
});

describe("statements that are not high risk", () => {
  test.each([
    ["nullable column", 'ALTER TABLE "t" ADD COLUMN "c" TEXT'],
    ["constant default", "ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0"],
    [
      "string default with a cast",
      "ALTER TABLE t ADD COLUMN c varchar(10) NOT NULL DEFAULT 'x'::varchar(10)",
    ],
    [
      "CURRENT_TIMESTAMP default",
      "ALTER TABLE t ADD COLUMN c timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ],
    ["now() default", "ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now()"],
    ["NOT VALID check", "ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID"],
    [
      "NOT VALID foreign key",
      "ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o(id) NOT VALID",
    ],
    ["VALIDATE CONSTRAINT", "ALTER TABLE t VALIDATE CONSTRAINT c"],
    ["unique using an index", "ALTER TABLE t ADD CONSTRAINT u UNIQUE USING INDEX i"],
    ["DROP NOT NULL", "ALTER TABLE t ALTER COLUMN c DROP NOT NULL"],
    ["SET DEFAULT", "ALTER TABLE t ALTER COLUMN c SET DEFAULT 1"],
    ["RENAME CONSTRAINT", "ALTER TABLE t RENAME CONSTRAINT a TO b"],
    ["CREATE TABLE", "CREATE TABLE t (id int PRIMARY KEY, o int REFERENCES other(id))"],
    ["CREATE INDEX CONCURRENTLY", "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)"],
    ["DROP INDEX", "DROP INDEX IF EXISTS i"],
    ["DROP INDEX CONCURRENTLY", "DROP INDEX CONCURRENTLY i"],
    ["INSERT", "INSERT INTO t (a) VALUES (1)"],
    ["enum value", "ALTER TYPE e ADD VALUE 'x'"],
    ["CREATE TYPE", "CREATE TYPE e AS ENUM ('a')"],
    ["COMMENT", "COMMENT ON TABLE t IS 'DROP TABLE t'"],
    ["SET lock_timeout", "SET lock_timeout = '5s'"],
    ["DROP TYPE", "DROP TYPE e"],
  ])("%s", (_name, sql) => {
    expect(summarize(sql).filter((line) => line.includes("HIGH"))).toEqual([]);
  });
});

test("DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, the plain form ACCESS EXCLUSIVE", () => {
  expect(summarize("DROP INDEX CONCURRENTLY i")).toEqual(["DROP INDEX | share-update-exclusive"]);
  expect(summarize("DROP INDEX i")).toEqual(["DROP INDEX | access-exclusive"]);
});

describe("statements judged by the size of their table", () => {
  test.each([
    [
      "UPDATE with a WHERE",
      "UPDATE t SET a = 1 WHERE b = 2",
      "UPDATE | row-exclusive | scans | HIGH",
    ],
    ["DELETE with a WHERE", "DELETE FROM t WHERE b = 2", "DELETE | row-exclusive | scans | HIGH"],
    [
      "WHERE (true)",
      "UPDATE t SET a = 1 WHERE (true)",
      "UPDATE without WHERE | row-exclusive | scans | HIGH",
    ],
    [
      "WHERE (1 = 1)",
      "DELETE FROM t WHERE (1 = 1)",
      "DELETE without WHERE | row-exclusive | scans | HIGH",
    ],
    [
      "INSERT ... SELECT",
      "INSERT INTO t (a) SELECT a FROM u",
      "INSERT SELECT | row-exclusive | scans | HIGH",
    ],
  ])("%s", (_name, sql, expected) => {
    expect(summarize(sql)).toEqual([expected]);
  });
});

describe("ADD COLUMN defaults and types that rewrite", () => {
  test.each([
    ["serial", "ALTER TABLE t ADD COLUMN c serial"],
    ["bigserial", "ALTER TABLE t ADD COLUMN c BIGSERIAL"],
    ["smallserial", "ALTER TABLE t ADD COLUMN c smallserial"],
    ["serial4", "ALTER TABLE t ADD COLUMN c serial4"],
    ["serial8", "ALTER TABLE t ADD COLUMN c serial8"],
    ["a quoted function name", 'ALTER TABLE t ADD COLUMN c uuid DEFAULT "gen_random_uuid"()'],
    [
      "a schema-qualified function",
      "ALTER TABLE t ADD COLUMN c uuid DEFAULT pg_catalog.gen_random_uuid()",
    ],
    [
      "a quoted, qualified function",
      'ALTER TABLE t ADD COLUMN c uuid DEFAULT "public"."my_default"()',
    ],
    ["any other function", "ALTER TABLE t ADD COLUMN c text DEFAULT md5('x')"],
    ["nextval", "ALTER TABLE t ADD COLUMN c int DEFAULT nextval('s')"],
  ])("%s", (_name, sql) => {
    expect(summarize(sql)).toEqual(["ALTER TABLE ADD COLUMN | access-exclusive | scans | HIGH"]);
  });

  test("a cast to a sized type is not a call", () => {
    expect(summarize("ALTER TABLE t ADD COLUMN c text DEFAULT CAST('x' AS varchar(10))")).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
    ]);
  });
});

describe("CREATE TABLE and other statements that touch another table", () => {
  test("a foreign key locks the referenced table", () => {
    expect(summarize("CREATE TABLE n (id int REFERENCES big (id))")).toEqual([
      "CREATE TABLE | none",
      "CREATE TABLE REFERENCES | share-row-exclusive",
    ]);
  });

  test("a partition locks its parent", () => {
    expect(summarize("CREATE TABLE p PARTITION OF big FOR VALUES FROM (1) TO (2)")).toEqual([
      "CREATE TABLE | none",
      "CREATE TABLE PARTITION OF | access-exclusive",
    ]);
  });

  test("IF NOT EXISTS does not make the table new", () => {
    expect(classify(splitStatements("CREATE TABLE IF NOT EXISTS t (id int)")[0]!).creates).toEqual(
      [],
    );
    expect(classify(splitStatements("CREATE TABLE t (id int)")[0]!).creates).toEqual(["t"]);
  });

  test.each([
    ["ALTER DOMAIN ADD CONSTRAINT", "ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0)"],
    ["ALTER DOMAIN SET NOT NULL", "ALTER DOMAIN d SET NOT NULL"],
    ["ALTER INDEX SET TABLESPACE", "ALTER INDEX i SET TABLESPACE fast"],
  ])("%s is high risk", (_name, sql) => {
    expect(classify(splitStatements(sql)[0]!).effects[0]).toMatchObject({
      high: true,
      unknown: true,
    });
  });

  test("other ALTER DOMAIN and ALTER INDEX forms are not", () => {
    expect(summarize("ALTER DOMAIN d SET DEFAULT 1; ALTER INDEX i RENAME TO j")).toEqual([
      "ALTER DOMAIN | none",
      "ALTER INDEX | none",
    ]);
  });

  test("DROP TABLE ... CASCADE adds an unrecognised effect for what depends on it", () => {
    expect(summarize("DROP TABLE a CASCADE")).toEqual([
      "DROP TABLE | access-exclusive | HIGH",
      "DROP TABLE CASCADE | access-exclusive | scans | HIGH",
    ]);
  });
});

describe("unrecognised statements are high risk", () => {
  test.each([
    ["DO block", "DO $$ BEGIN ALTER TABLE t DROP COLUMN c; END $$"],
    ["EXECUTE", "EXECUTE my_plan(1)"],
    ["SELECT", "SELECT my_function()"],
    ["CTE", "WITH x AS (SELECT 1) UPDATE t SET a = 1"],
    ["CREATE TRIGGER", "CREATE TRIGGER g BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()"],
    ["unknown ALTER TABLE action", "ALTER TABLE t SET LOGGED"],
    ["DROP TYPE CASCADE", "DROP TYPE e CASCADE"],
    ["gibberish", "FROBNICATE t"],
  ])("%s", (_name, sql) => {
    const effects = splitStatements(sql).flatMap((statement) => classify(statement).effects);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ high: true, unknown: true, lock: "access-exclusive" });
  });

  test("an unrecognised ALTER TABLE action carries the table's name", () => {
    const [effect] = classify(splitStatements("ALTER TABLE big SET UNLOGGED")[0]!).effects;
    expect(effect).toMatchObject({ unknown: true });
    expect(effect!.mentions).toContain("big");
  });

  test("a DO block's mentions include a statement it EXECUTEs from a string", () => {
    const sql = "DO $$ BEGIN EXECUTE 'ALTER TABLE big ALTER COLUMN a TYPE bigint'; END $$";
    expect(classify(splitStatements(sql)[0]!).effects[0]!.mentions).toContain("big");
  });

  test("a DO block's mentions include the names in its body", () => {
    const [effect] = classify(
      splitStatements('DO $$ BEGIN ALTER TABLE "Big" DROP COLUMN c; END $$')[0]!,
    ).effects;
    expect(effect!.mentions).toContain("Big");
  });
});

describe("text that only looks like SQL", () => {
  test("keywords inside comments are ignored", () => {
    expect(summarize("-- DROP TABLE t;\n/* TRUNCATE t; */ SELECT_NOT; ")).toEqual([
      "unrecognised statement | access-exclusive | scans | HIGH",
    ]);
    expect(summarize("ALTER TABLE t ADD COLUMN c int -- NOT NULL\n")).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
    ]);
    expect(
      summarize("/* DROP COLUMN */ ALTER TABLE t ADD COLUMN c int /* SET NOT NULL */"),
    ).toEqual(["ALTER TABLE ADD COLUMN | access-exclusive"]);
  });

  test("keywords inside strings and quoted identifiers are ignored", () => {
    expect(summarize(`INSERT INTO t (a) VALUES ('DROP TABLE t; TRUNCATE t')`)).toEqual([
      "INSERT | row-exclusive",
    ]);
    expect(summarize(`ALTER TABLE t ADD COLUMN "NOT NULL" int DEFAULT 'random()'`)).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
    ]);
    expect(summarize(`ALTER TABLE "DROP TABLE" ADD COLUMN c int`)).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
    ]);
    expect(summarize(`UPDATE t SET a = 'x WHERE y' `)).toEqual([
      "UPDATE without WHERE | row-exclusive | scans | HIGH",
    ]);
  });

  test("several statements on one line are each classified", () => {
    expect(
      summarize(
        "ALTER TABLE a ADD COLUMN x int; DROP TABLE b; TRUNCATE c; DELETE FROM d WHERE x = 1",
      ),
    ).toEqual([
      "ALTER TABLE ADD COLUMN | access-exclusive",
      "DROP TABLE | access-exclusive | HIGH",
      "TRUNCATE | access-exclusive | HIGH",
      "DELETE | row-exclusive | scans | HIGH",
    ]);
  });
});

describe("names", () => {
  test.each([
    ["unquoted names are lower-cased", "UPDATE Users SET a = 1", "users"],
    ["quoted names keep their case", 'UPDATE "Users" SET a = 1', "Users"],
    ["public. is dropped", 'UPDATE public."Users" SET a = 1', "Users"],
    ["a quoted public schema is dropped too", 'UPDATE "public".t SET a = 1', "t"],
    ["another schema stays", "UPDATE audit.t SET a = 1", "audit.t"],
  ])("%s", (_name, sql, table) => {
    expect(classify(splitStatements(sql)[0]!).effects[0]!.table).toBe(table);
  });
});

describe("lock_timeout statements", () => {
  test.each([
    ["SET lock_timeout = '5s'", { local: false, ms: 5000 }],
    ["SET lock_timeout TO 2000", { local: false, ms: 2000 }],
    ["SET SESSION lock_timeout = '1min'", { local: false, ms: 60_000 }],
    ["SET LOCAL lock_timeout = '5s'", { local: true, ms: 5000 }],
    ["SET lock_timeout = '500ms'", { local: false, ms: 500 }],
    ["SET lock_timeout = DEFAULT", { local: false, ms: undefined }],
    ["RESET lock_timeout", { local: false, reset: true }],
  ])("%s", (sql, expected) => {
    expect(classify(splitStatements(sql)[0]!).lockTimeout).toEqual(expected);
  });

  test("another setting is not one", () => {
    expect(
      classify(splitStatements("SET statement_timeout = '5s'")[0]!).lockTimeout,
    ).toBeUndefined();
  });
});
