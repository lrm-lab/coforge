import { expect, test } from "bun:test";
import { authorViolation } from "./hard-rules";
import { useTestRepo } from "../git-hooks/test-repo";

// The rules judged on a change: new suppressions, the author identity, and the size ratchet in
// range mode. The suppression tokens are assembled at run time so that this file's own added
// lines carry none of them.
const ESLINT = ["eslint", "disable-next-line"].join("-");
const OXLINT = ["oxlint", "disable"].join("-");
const TS_IGNORE = ["@ts", "ignore"].join("-");
const TS_EXPECT = ["@ts", "expect", "error"].join("-");
const BIOME = ["biome", "ignore"].join("-");
const SKIP = (name: string) => [name, "skip("].join(".");
const ONLY = (name: string) => [name, "only("].join(".");
const RUST_ALLOW = ["#", "[allow(dead_code)]"].join("");

const repo = useTestRepo();

test("each new suppression comment is blocked with its file, line, and the approval rule", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/a.ts": `export const a = 1;\n// ${ESLINT} no-console\n/* ${OXLINT} */\n`,
    "src/b.tsx": `// ${TS_IGNORE}\nexport const b = 1;\n  /** ${TS_EXPECT} */\n`,
    "src/c.css": `/* ${BIOME} lint: reason */\n`,
    "crates/x/src/lib.rs": `${RUST_ALLOW}\nfn unused() {}\n`,
    // Its patch row is `+++ ...`, which only the hunk's line count tells from a file header.
    "src/d.js": `let i = 0;\n++ i; /* ${OXLINT} */\n`,
  });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  for (const location of [
    "src/a.ts:2",
    "src/a.ts:3",
    "src/b.tsx:1",
    "src/b.tsx:3",
    "src/c.css:1",
    "crates/x/src/lib.rs:1",
    "src/d.js:2",
  ])
    expect(result.stderr).toContain(location);
  expect(result.stderr).toContain("new-suppression");
  expect(result.stderr).toContain(ESLINT);
  expect(result.stderr).toContain("prior approval");
  expect(result.stderr).toContain("AGENTS.md");
});

test("skipped and focused tests are blocked in test files only", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "test/a.test.ts": `${SKIP("test")}"a", () => {});\n${ONLY("describe")}"b", () => {});\n`,
    "src/b.spec.tsx": `${SKIP("it")}"c", () => {});\n${SKIP("describe")}"d", () => {});\n`,
    "src/iter.rs": `fn f() { let _ = ${SKIP("v.iter()")}1); }\n`,
    "src/list.ts": `export const rest = (q: { skip(n: number): void }) => ${SKIP("q")}1);\n`,
  });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  for (const location of ["test/a.test.ts:1", "test/a.test.ts:2", "src/b.spec.tsx:1"])
    expect(result.stderr).toContain(location);
  expect(result.stderr).toContain("src/b.spec.tsx:2");
  expect(result.stderr).not.toContain("src/iter.rs");
  expect(result.stderr).not.toContain("src/list.ts");
});

test("existing suppressions are not flagged, and Markdown may name the tokens", () => {
  repo.seed({ "src/a.ts": `// ${ESLINT} no-console\nconsole.log(1);\n`, "README.md": "# Repo\n" });
  repo.write({
    "src/a.ts": `// ${ESLINT} no-console\nconsole.log(2);\n`,
    "docs/rules.md": `Never add \`// ${TS_IGNORE}\` or \`${SKIP("test")}\`.\n`,
  });

  const result = repo.commitAll();

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("range mode flags suppressions added anywhere in the range, and only those", () => {
  const base = repo.seed({ "src/old.ts": `// ${TS_IGNORE}\nexport const x: number = "";\n` });
  repo.ok("mv", "src/old.ts", "src/renamed.ts");
  repo.seed({});
  expect(repo.range(base).exitCode).toBe(0);

  repo.seed({ "src/new.ts": `\n\n// ${OXLINT}-next-line no-console\n` });

  const result = repo.range(base);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("src/new.ts:3");
  expect(result.stderr).not.toContain("src/renamed.ts");
});

test("the author identity rule matches Agent and bot identities, never a human's", () => {
  for (const [name, email] of [
    ["coforge-refactor", "frank@example.com"],
    ["Frank", "coforge-refactor@example.com"],
    ["Claude", "noreply@anthropic.com"],
    ["Frank", "frank@anthropic.com"],
    ["Cursor Agent", "cursoragent@cursor.com"],
    ["github-actions[bot]", "41898282+github-actions@users.noreply.github.com"],
    ["Builder", "build-agent@example.com"],
    ["CoForge-Pref", "x@example.com"],
  ])
    expect(authorViolation(name!, email!), `${name} <${email}>`).toBeDefined();
  for (const [name, email] of [
    ["me-frankan", "me.frankan@gmail.com"],
    ["exp-repair", "65881810+exp-repair@users.noreply.github.com"],
    ["Ann Coforge", "ann@coforge.dev"],
    ["agent smith", "agent@example.com"],
    ["Robot", "anthropic.com@example.com"],
  ])
    expect(authorViolation(name!, email!), `${name} <${email}>`).toBeUndefined();
});

test("the hook blocks a commit authored as an Agent or bot, from the environment or --author", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "src/a.ts": "export const a = 1;\n" });

  const fromEnvironment = repo.commitAll({ GIT_AUTHOR_EMAIL: "noreply@anthropic.com" });
  expect(fromEnvironment.exitCode).not.toBe(0);
  expect(fromEnvironment.stderr).toContain("author-identity");
  expect(fromEnvironment.stderr).toContain("noreply@anthropic.com");
  expect(fromEnvironment.stderr).toContain("git config user.email");

  const fromOption = repo.commitAll({}, "--author", "coforge-bot <bot@example.com>");
  expect(fromOption.exitCode).not.toBe(0);
  expect(fromOption.stderr).toContain("coforge-bot");

  // A co-author trailer is not the author.
  const trailer = repo.commitAll({}, "-m", "Co-Authored-By: Claude <noreply@anthropic.com>");
  expect(trailer.stderr).toBe("");
  expect(trailer.exitCode).toBe(0);
});

test("range mode checks the author of every commit in the range", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  repo.seed({ "a.txt": "a\n" });
  expect(repo.range(base).exitCode).toBe(0);

  const botCommit = repo.seed({ "b.txt": "b\n" }, { env: { GIT_AUTHOR_NAME: "renovate[bot]" } });
  repo.seed({ "c.txt": "c\n" });

  const result = repo.range(base);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("author-identity");
  expect(result.stderr).toContain(botCommit.slice(0, 12));
  expect(result.stderr).toContain("renovate[bot]");
  expect(result.stderr).toContain("rebase");
  // Commits before the base are not the range's.
  expect(repo.range(botCommit).exitCode).toBe(0);
});

test("range mode applies the size ratchet to the range as a whole", () => {
  const big = (bytes: number) => "x".repeat(bytes);
  const attributes = { ".gitattributes": "*.lock linguist-generated\n" };
  const base = repo.seed({ "legacy.ts": big(30_000), "small.ts": big(100), ...attributes });
  repo.seed({ "legacy.ts": big(29_000) });
  repo.ok("mv", "legacy.ts", "renamed.ts");
  repo.seed({ "deps.lock": big(90_000) });
  expect(repo.range(base).stderr).toBe("");

  repo.seed({ "small.ts": big(20_001), "fresh.ts": big(25_000), "renamed.ts": big(30_001) });

  const result = repo.range(base);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("size-ratchet");
  const lines = result.stderr.split("\n");
  expect(lines.find((line) => line.includes("small.ts"))).toContain("crossed the limit");
  expect(lines.find((line) => line.includes("fresh.ts"))).toContain("new file");
  expect(lines.find((line) => line.includes("renamed.ts"))).toContain(
    "grew from 30,000 to 30,001 bytes (legacy.ts at the base)",
  );
  expect(result.stderr).not.toContain("deps.lock");
});

test("range mode diffs from the merge base, like a pull request", () => {
  const base = repo.seed({ "legacy.ts": "x".repeat(30_000) });
  repo.ok("switch", "-q", "-c", "feature");
  repo.seed({ "a.txt": "a\n" });
  const head = repo.head();
  repo.ok("switch", "-q", "main");
  // Diffed from main itself rather than the merge base, the feature would grow legacy.ts back.
  repo.seed({ "legacy.ts": "x".repeat(25_000), "big.ts": "x".repeat(30_000) });

  expect(repo.range("main", head).exitCode).toBe(0);
  expect(repo.range(base, "main").exitCode).not.toBe(0);
});

test("a push's author check covers the commits it introduced; an unknown before means the range", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  const bot = repo.seed({ "a.txt": "a\n" }, { env: { GIT_AUTHOR_NAME: "renovate[bot]" } });
  repo.seed({ "b.txt": "b\n" });
  const push = (before: string) => repo.range(base, "HEAD", "--authors-since", before);

  // An earlier push brought the bot commit; this one, from `bot`, only a person's commit.
  expect(push(bot)).toMatchObject({ exitCode: 0, stderr: "" });
  for (const before of [base, "", "0".repeat(40)]) {
    const result = push(before);
    expect(result.exitCode, before).not.toBe(0);
    expect(result.stderr).toContain(bot.slice(0, 12));
  }
});

test("paths with spaces are judged by their real name", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/my thing.test.ts": `${SKIP("test")}"a", () => {});\n`,
    "my notes.md": `Never add \`// ${TS_IGNORE}\`.\n`,
  });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("src/my thing.test.ts:1");
  expect(result.stderr).not.toContain("my notes.md");
});

test("moving a suppression is not a new one, but a second identical one is", () => {
  const original = `export const a = 1;\n// ${TS_EXPECT}\nexport const b: number = "";\n`;
  const moved = `// ${TS_EXPECT}\nexport const b: number = "";\n`;
  repo.seed({ "src/a.ts": original });
  repo.write({ "src/a.ts": "export const a = 1;\n", "src/b.ts": moved });
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });

  repo.write({ "src/b.ts": "export {};\n", "src/c.ts": moved, "src/d.ts": moved });
  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("new-suppression (1)");
});

test("every skip and focus call in a test file is blocked; skipIf and todo are not", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/a.test.ts": [
      `${SKIP("test.concurrent")}"a", () => {});`,
      `${SKIP("bench")}"b", () => {});`,
      `${SKIP("suite")}"c", () => {});`,
      `${ONLY("test.concurrent")}"d", () => {});`,
      `test.skipIf(true)("e", () => {});`,
      `test.todo("f");`,
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (4)");
  for (const line of [1, 2, 3, 4]) expect(result.stderr).toContain(`src/a.test.ts:${line}`);
});

test("a registered skill directory is exempt from the file rules, not from the author rule", () => {
  const lock = { skills: { "vendored-skill": {} } };
  repo.seed({ "skills-lock.json": JSON.stringify(lock) });
  const files = (skill: string) => ({
    [`.agents/skills/${skill}/scripts/big.ts`]: "x".repeat(20_001),
    [`.agents/skills/${skill}/scripts/lint.ts`]: `// ${ESLINT} no-console\n`,
  });
  repo.write(files("vendored-skill"));
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });
  expect(repo.commitAll({ GIT_AUTHOR_NAME: "coforge-x" }, "--allow-empty").exitCode).not.toBe(0);

  repo.write(files("own-skill"));
  const result = repo.commitAll();

  expect(result.stderr).toContain(".agents/skills/own-skill/scripts/big.ts");
  expect(result.stderr).toContain(".agents/skills/own-skill/scripts/lint.ts:1");
  expect(result.stderr).not.toContain("vendored-skill");
});

test("editing a line that already carries a suppression is not a new one; a second one is", () => {
  const LINE = ["eslint", "disable", "line"].join("-");
  const effect = (deps: string) => `useEffect(f, [${deps}]); // ${LINE} exhaustive-deps\n`;
  const skipped = (name: string) => `${SKIP("test")}"${name}", () => {});\n`;
  repo.seed({ "src/a.tsx": effect("a"), "src/a.test.ts": skipped("old name") });
  repo.write({ "src/a.tsx": effect("a, b"), "src/a.test.ts": skipped("new name") });
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });

  repo.write({ "src/a.tsx": effect("a, b") + effect("c") });
  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("new-suppression (1)");
  expect(result.stderr).toContain("src/a.tsx:2");
});

test("a line removed from Markdown or a vendored skill does not cancel a new suppression", () => {
  repo.seed({
    "skills-lock.json": JSON.stringify({ skills: { v: {} } }),
    "guide.md": `# Guide\n\n\`\`\`ts\n// ${ESLINT} no-console\n\`\`\`\n`,
    ".agents/skills/v/x.ts": `// ${TS_IGNORE}\nexport const x = 1;\n`,
  });
  repo.write({
    "guide.md": "# Guide\n",
    ".agents/skills/v/x.ts": "export const x = 1;\n",
    "src.ts": `// ${ESLINT} no-console\n// ${TS_IGNORE}\nexport {};\n`,
  });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("new-suppression (2)");
});

test("ts-nocheck, skip.each, only.each and tagged-template skips are blocked", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/a.ts": `// ${["@ts", "nocheck"].join("-")}\nexport {};\n`,
    "src/b.test.ts": [
      `${["test", "skip", "each("].join(".")}[1])("a %d", () => {});`,
      `${["describe", "only", "each`"].join(".")}a\n\${1}\`("b", () => {});`,
      `${["test", "skip "].join(".")}("c", () => {});`,
      "",
    ].join("\n"),
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (4)");
  for (const location of ["src/a.ts:1", "src/b.test.ts:1", "src/b.test.ts:2", "src/b.test.ts:4"])
    expect(result.stderr).toContain(location);
});

test("a file the diff treats as binary still has its added lines checked", () => {
  repo.seed({ ".gitattributes": "src/*.ts -diff\n" });
  repo.write({ "src/a.ts": `// ${TS_IGNORE}\nexport const a: number = "";\n` });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("src/a.ts:1");
});

test("a directive on its own line in a block comment is blocked, with or without a star", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "src/a.ts": `/*\n  ${OXLINT} no-console\n*/\n/**\n * ${TS_IGNORE}\n */\n`,
    "src/lib.rs": `${["#", "[expect(dead_code)]"].join("")}\n${["#!", "[expect(x)]"].join("")}\n`,
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (4)");
  for (const location of ["src/a.ts:2", "src/a.ts:5", "src/lib.rs:1", "src/lib.rs:2"])
    expect(result.stderr).toContain(location);
});

test("a malformed skills-lock.json is reported in one line, with exit 2 and no stack", () => {
  repo.seed({ "README.md": "# Repo\n" });
  for (const lock of ["{ not json", "null"]) {
    // The lock is read from the base, HEAD.
    repo.seed({ "skills-lock.json": lock });
    repo.write({ "docs/a.md": `[readme](../README.md) ${lock}\n` });
    repo.ok("add", "-A");
    // The checker as the hook runs it; `git commit` itself exits 1 for any failing hook.
    const result = repo.check(["--staged"], { GITHUB_ACTIONS: "false" });
    expect(result.exitCode, lock).toBe(2);
    expect(result.stderr).toStartWith("hard-rules: skills-lock.json");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  }
});

test("a line-start directive counts only in files with block comments; .mdc is Markdown", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "notes.txt": `${OXLINT} comments are forbidden here\n * ${TS_IGNORE} too\n`,
    "config.yml": `note: |\n  ${ESLINT} is not allowed\n`,
    "run.sh": `cat <<EOF\n${TS_IGNORE} in a heredoc\nEOF\n`,
    "rules.mdc": `// ${TS_IGNORE}\n`,
    "src/style.css": `/*\n  ${BIOME} lint: reason\n*/\n`,
  });

  const result = repo.commitAll();

  expect(result.stderr).toContain("new-suppression (1)");
  expect(result.stderr).toContain("src/style.css:2");
});

test("a NUL byte early in a file does not hide a new suppression", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({ "src/data.ts": `export const raw = "\0";\n// ${TS_IGNORE}\n` });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("src/data.ts:2");
});
