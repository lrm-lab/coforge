import { expect, test } from "bun:test";
import { useTestRepo } from "../git-hooks/test-repo";

// Test-skip forms and cargo-deny exemptions the new-suppression rule blocks. The tokens are
// assembled at run time so that this file's own added lines carry none of them.
const SKIP = (name: string) => [name, "skip("].join(".");
const ONLY = (name: string) => [name, "only("].join(".");
const SKIP_IF = (name: string) => [name, "skipIf(true)"].join(".");
const TODO = (name: string) => [name, "todo("].join(".");
const XIT = ["x", "it("].join("");

const repo = useTestRepo();

test("every skip, focus, conditional skip, todo and x-prefixed call in a test file is blocked", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/a.test.ts": [
      `${SKIP("test.concurrent")}"a", () => {});`,
      `${SKIP("bench")}"b", () => {});`,
      `${SKIP("suite")}"c", () => {});`,
      `${ONLY("test.concurrent")}"d", () => {});`,
      `${SKIP_IF("test")}("e", () => {});`,
      `${TODO("test")}"f");`,
      `${XIT}"g", () => {});`,
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (7)");
  for (const line of [1, 2, 3, 4, 5, 6, 7])
    expect(result.stderr).toContain(`src/a.test.ts:${line}`);
});

test("a function merely named like a test helper is not flagged outside test files", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "src/a.ts": `${XIT}"g");\nconst q = { ${SKIP_IF("q")} };\n` });

  expect(repo.commitAll().exitCode).toBe(0);
});

test("a new cargo-deny skip, ignore or exceptions key is blocked; an unchanged one is not", () => {
  const existing = 'ignore = ["RUSTSEC-2020-0001"]\n';
  repo.seed({ "crates/a/deny.toml": existing });
  repo.write({
    "crates/a/deny.toml": `${existing}skip = [\n  { crate = "syn@1" },\n]\nexceptions = []\n[bans]\nmultiple-versions = "deny"\n`,
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (2)");
  expect(result.stderr).toContain("crates/a/deny.toml:2");
  expect(result.stderr).toContain("crates/a/deny.toml:5");
  expect(result.stderr).not.toContain("crates/a/deny.toml:1");
});

test("a new ban in deny.toml is not an exemption", () => {
  repo.seed({ "deny.toml": "[bans]\ndeny = []\n" });
  repo.write({ "deny.toml": '[bans]\ndeny = [\n  { name = "openssl" },\n]\n' });

  expect(repo.commitAll().exitCode).toBe(0);
});

test("a deny.toml line that only changes a policy level is not an exemption", () => {
  repo.seed({ "deny.toml": '[bans]\nmultiple-versions = "warn"\n' });
  repo.write({ "deny.toml": '[bans]\nmultiple-versions = "deny"\n' });

  expect(repo.commitAll().exitCode).toBe(0);
});
