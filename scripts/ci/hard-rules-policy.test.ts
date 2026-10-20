import { expect, test } from "bun:test";
import { useTestRepo } from "../git-hooks/test-repo";

// The exemption lists, skills-lock.json (vendored skills) and .gitattributes (`linguist-generated`
// files skip the size ratchet), are read from the change's base, so a change cannot exempt itself.
// The suppression token is assembled at run time so that this file carries none.
const ESLINT = ["eslint", "disable-next-line"].join("-");
const BIG = "x".repeat(30_000);

const repo = useTestRepo();

const lockWith = (skill: string) => ({
  "skills-lock.json": JSON.stringify({ skills: { [skill]: {} } }),
});
const skillFiles = {
  ".agents/skills/mine/big.ts": BIG,
  ".agents/skills/mine/lint.ts": `// ${ESLINT} no-console\n`,
};
const generatedAttribute = { ".gitattributes": "src/** linguist-generated\n" };

function expectBlockedSkill(result: { exitCode: number; stderr: string }) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(".agents/skills/mine/big.ts: 7,500 tokens, new file");
  expect(result.stderr).toContain(".agents/skills/mine/lint.ts:1");
}

function expectBlockedGenerated(result: { exitCode: number; stderr: string }) {
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("src/big.ts: 7,500 tokens, new file");
}

test("a commit that registers a skill cannot exempt that skill's own files", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ ...lockWith("mine"), ...skillFiles });

  expectBlockedSkill(repo.commitAll());
});

test("a commit that marks files linguist-generated cannot exempt them from the size ratchet", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ ...generatedAttribute, "src/big.ts": BIG });

  expectBlockedGenerated(repo.commitAll());
});

test("the first commit has no base, so no list exempts anything", () => {
  repo.write({ ...lockWith("mine"), ...skillFiles });

  expectBlockedSkill(repo.commitAll());
});

test("committing the list first and the files second passes", () => {
  repo.seed({ "README.md": "# Repo\n" });

  repo.write(lockWith("mine"));
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });
  repo.write(skillFiles);
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });

  repo.write(generatedAttribute);
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });
  repo.write({ "src/big.ts": BIG });
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });
});

test("a range whose base lacks the list entry blocks the files, even in a later commit", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  repo.seed({ ...lockWith("mine"), ...generatedAttribute });
  repo.seed({ ...skillFiles, "src/big.ts": BIG });

  const result = repo.range(base);

  expectBlockedSkill(result);
  expectBlockedGenerated(result);
  // Once a range that holds the lists has passed, the next range's base has them.
  expect(repo.range("HEAD~1")).toMatchObject({ exitCode: 0, stderr: "" });
});
