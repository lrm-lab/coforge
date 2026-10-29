import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTestRepo } from "../git-hooks/test-repo";
import {
  analyze,
  declaredExports,
  functionBodies,
  importedStems,
  isCandidatePath,
  renderMarkdown,
  stripNoise,
} from "./dead-code";

const longBody = `  const value = input.trim();
  if (value.length === 0) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);`;

const script = join(import.meta.dir, "dead-code.ts");
const repo = useTestRepo();

test("a declaration is found with the kind and the line it starts on", () => {
  const text = [
    "import { x } from './x';",
    "",
    "export function alpha() {}",
    "export const beta = 1;",
    "export type Gamma = string;",
  ].join("\n");
  expect(declaredExports(text)).toEqual([
    { name: "alpha", kind: "value", line: 3, assertion: false },
    { name: "beta", kind: "value", line: 4, assertion: false },
    { name: "Gamma", kind: "type", line: 5, assertion: false },
  ]);
});

test("a declaration inside a comment is not an export", () => {
  const text = "/*\nexport function dead() {}\n*/\nexport function live() {}\n";
  expect(declaredExports(text).map((entry) => entry.name)).toEqual(["live"]);
});

test("a const enum is one declaration, not a declaration named enum", () => {
  expect(declaredExports("export const enum Mode {\n  A,\n}\n")).toEqual([
    { name: "Mode", kind: "value", line: 1, assertion: false },
  ]);
});

test("only product and package source is a candidate", () => {
  expect(isCandidatePath("packages/x/src/a.ts")).toBe(true);
  expect(isCandidatePath("apps/web/src/server/a.ts")).toBe(true);
  expect(isCandidatePath("packages/x/src/index.ts")).toBe(false);
  expect(isCandidatePath("apps/web/src/routes/a.tsx")).toBe(false);
  expect(isCandidatePath("packages/x/src/a.test.ts")).toBe(false);
  expect(isCandidatePath("apps/web/src/generated/prisma/client.ts")).toBe(false);
  expect(isCandidatePath("packages/x/src/a_pb.ts")).toBe(false);
});

test("an export nothing names is unused, one its own file uses is internal, one elsewhere is not reported", () => {
  const report = analyze(
    new Map([
      [
        "packages/x/src/a.ts",
        [
          "export function unused() {}",
          "export function internal() {}",
          "export function used() {}",
          "internal();",
        ].join("\n"),
      ],
      ["packages/x/src/b.ts", "import { used } from './a';\nused();"],
    ]),
  );
  expect(report.unused.map((entry) => entry.name)).toEqual(["unused"]);
  expect(report.internal.map((entry) => entry.name)).toEqual(["internal"]);
  expect(report.unused[0]).toMatchObject({ path: "packages/x/src/a.ts", line: 1, sameFileUses: 1 });
  expect(report.internal[0]).toMatchObject({ sameFileUses: 2 });
});

test("a compile-time assertion constant is not reported as dead code", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/events.ts", "export const eventsMatch: Both<A, B> = true;"],
      ["packages/x/src/flag.ts", "export const flag = true;"],
    ]),
  );
  expect(report.unused.map((entry) => entry.name)).toEqual(["flag"]);
});

test("two dead declarations of one name are both unused", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/a.ts", "export function twin() {}"],
      ["packages/x/src/b.ts", "export function twin() {}"],
    ]),
  );
  expect(report.unused.map((entry) => `${entry.name}@${entry.path}`)).toEqual([
    "twin@packages/x/src/a.ts",
    "twin@packages/x/src/b.ts",
  ]);
});

test("a module nothing imports is reported, an imported one and an entry point are not", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/lonely.ts", "export const a = 1;"],
      ["packages/x/src/used.ts", "export const b = 2;"],
      ["packages/x/src/main.ts", "export const c = 3;"],
      ["apps/web/src/consumer.ts", "import { b } from './used';"],
    ]),
  );
  const paths = report.modules.map((module) => module.path);
  expect(paths).toContain("packages/x/src/lonely.ts");
  expect(paths).not.toContain("packages/x/src/used.ts");
  expect(paths).not.toContain("packages/x/src/main.ts");
});

test("an import with an explicit extension still names its module", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/alpha.ts", "export const a = 1;"],
      ["apps/web/src/consumer.ts", "import { a } from './alpha.ts';"],
    ]),
  );
  expect(report.modules.map((module) => module.path)).not.toContain("packages/x/src/alpha.ts");
});

test("a bare side-effect import and a require both name their module", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/register.ts", "export const a = 1;"],
      ["packages/x/src/legacy.ts", "export const b = 2;"],
      ["apps/web/src/consumer.ts", "import './register';\nrequire('./legacy');"],
    ]),
  );
  const paths = report.modules.map((module) => module.path);
  expect(paths).not.toContain("packages/x/src/register.ts");
  expect(paths).not.toContain("packages/x/src/legacy.ts");
});

test("a module the build names by its path is not orphaned", () => {
  const report = analyze(
    new Map([
      ["apps/web/src/server/plugin.server.ts", "export const plugin = 1;"],
      ["apps/web/vite.config.ts", "export default { plugins: ['./src/server/plugin.server.ts'] };"],
    ]),
  );
  expect(report.modules.map((module) => module.path)).not.toContain(
    "apps/web/src/server/plugin.server.ts",
  );
});

test("the same function body in two files is a duplicate; a short body is not", () => {
  const body = `export function parse(input: string) {\n${longBody}\n}`;
  const report = analyze(
    new Map([
      ["packages/x/src/a.ts", body],
      ["packages/x/src/b.ts", body],
      ["packages/x/src/c.ts", "export function tiny() { return 1; }"],
    ]),
  );
  expect(report.duplicates).toHaveLength(1);
  expect(report.duplicates[0]!.name).toBe("parse");
  expect(report.duplicates[0]!.copies.map((copy) => copy.path)).toEqual([
    "packages/x/src/a.ts",
    "packages/x/src/b.ts",
  ]);
});

test("an arrow function assigned to a const is compared too", () => {
  const body = `export const parse = (input: string) => {\n${longBody}\n}`;
  const report = analyze(
    new Map([
      ["packages/x/src/a.ts", body],
      ["packages/x/src/b.ts", body],
    ]),
  );
  expect(report.duplicates).toHaveLength(1);
  expect(report.duplicates[0]!.name).toBe("parse");
});

test("a brace or a quote inside a string, a regex or a comment does not cut the body short", () => {
  const body = [
    "export function matcher(input: string) {",
    '  const json = "}";',
    "  // } a comment brace",
    "  const quoted = /['\"`]/;",
    "  const braces = /a{2,3}/;",
    "  const text = `${json} }`;",
    `  const filler = "${"x".repeat(140)}";`,
    "  return quoted.test(input) && braces.test(text) && json.length > 0;",
    "}",
  ].join("\n");
  const [parsed] = functionBodies(body);
  expect(parsed!.body.endsWith("json.length > 0;")).toBe(true);
  expect(parsed!.body.length).toBeGreaterThan(140);
  expect(parsed!.line).toBe(1);
});

test("a regex containing a quote does not blank the rest of the file", () => {
  const text = [
    "export function check(input: string) {",
    "  const ok = /['\"]/.test(input);",
    "  return ok;",
    "}",
    "",
    "export function after() {",
    "  return 1;",
    "}",
  ].join("\n");
  const names = functionBodies(text).map((body) => body.name);
  expect(names).toEqual(["check", "after"]);
  expect(functionBodies(text)[0]!.body).toContain("return ok;");
});

test("an astral character does not shift the body scanner", () => {
  const text = [
    "// 🎉 a comment before the function",
    "export function alpha(input: string) {",
    '  const json = "}";',
    "  return input.length > 0 ? json : input;",
    "}",
  ].join("\n");
  expect(stripNoise(text)).toHaveLength(text.length);
  const [parsed] = functionBodies(text);
  expect(parsed!.body.startsWith("const json")).toBe(true);
  expect(parsed!.body.endsWith("json : input;")).toBe(true);
});

test("a duplicate is found when only one side has an astral character", () => {
  const body = `export function parse(input: string) {\n${longBody}\n}`;
  const report = analyze(
    new Map([
      ["packages/x/src/a.ts", body],
      ["packages/x/src/b.ts", `// 🎉 before the function\n${body}`],
    ]),
  );
  expect(report.duplicates).toHaveLength(1);
  expect(report.duplicates[0]!.name).toBe("parse");
});

test("noise stripping keeps every newline and every code character", () => {
  const text = 'const a = "x\\ny";\n// comment\nconst b = `z`;\nconst c = /[\\]]/;\n';
  const stripped = stripNoise(text);
  expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
  expect(stripped).toContain("const a =");
  expect(stripped).toContain("const b =");
  expect(stripped).toContain("const c =");
  expect(stripped).not.toContain("comment");
});

test("function bodies carry their name and line", () => {
  expect(functionBodies("export async function go() {\n  return 1;\n}\n")).toEqual([
    { name: "go", line: 1, body: "return 1;" },
  ]);
});

test("import stems name the imported module without its extension", () => {
  expect(
    importedStems("import { a } from './alpha.ts';\nimport('./beta');\nimport './gamma';"),
  ).toEqual(["alpha", "beta", "gamma"]);
});

test("the report names each section with its count", () => {
  const markdown = renderMarkdown({
    files: 3,
    candidates: 2,
    modules: [{ path: "packages/x/src/lonely.ts", lines: 4 }],
    unused: [
      { name: "gone", kind: "value", path: "packages/x/src/a.ts", line: 2, sameFileUses: 1 },
    ],
    internal: [
      { name: "Hidden", kind: "type", path: "packages/x/src/b.ts", line: 3, sameFileUses: 2 },
    ],
    duplicates: [
      {
        name: "parse",
        copies: [
          { path: "a.ts", line: 1 },
          { path: "b.ts", line: 1 },
        ],
      },
    ],
  });
  expect(markdown).toContain("2 of them candidate source");
  expect(markdown).toContain("## Modules nothing imports (1)");
  expect(markdown).toContain("`packages/x/src/lonely.ts` (4 lines)");
  expect(markdown).toContain("## Exports nothing references anywhere (1)");
  expect(markdown).toContain("`gone` - `packages/x/src/a.ts:2`");
  expect(markdown).toContain("## Exports only their own file uses (1)");
  expect(markdown).toContain("`Hidden` (type) - `packages/x/src/b.ts:3`");
  expect(markdown).toContain("## Identical function bodies in more than one file (1)");
  expect(markdown).toContain("`parse` (2 copies)");
});

test("a long section is capped and says how many it left out", () => {
  const internal = Array.from({ length: 60 }, (_, index) => ({
    name: `n${index}`,
    kind: "value" as const,
    path: "packages/x/src/a.ts",
    line: index + 1,
    sameFileUses: 2,
  }));
  const markdown = renderMarkdown({
    files: 1,
    candidates: 1,
    modules: [],
    unused: [],
    internal,
    duplicates: [],
  });
  expect(markdown).toContain("and 10 more (run with --all)");
  expect(
    renderMarkdown(
      { files: 1, candidates: 1, modules: [], unused: [], internal, duplicates: [] },
      { limit: Number.POSITIVE_INFINITY },
    ),
  ).not.toContain("more (run with --all)");
});

test("the whole work tree is scanned when the script runs from a subdirectory", () => {
  repo.seed({
    "packages/x/src/lonely.ts": "export const lonely = 1;\n",
    "apps/web/src/consumer.ts": "export const consumer = 1;\n",
  });
  const result = repo.run([process.execPath, script], {}, join(repo.dir, "apps/web"));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("## Modules nothing imports (2)");
  expect(result.stdout).toContain("packages/x/src/lonely.ts");
  expect(result.stdout).toContain("apps/web/src/consumer.ts");
});

test("--json answers the same report in machine-readable form", () => {
  repo.seed({ "packages/x/src/lonely.ts": "export const lonely = 1;\n" });
  const result = repo.run([process.execPath, script, "--json"]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.candidates).toBe(1);
  expect(report.modules.map((module: { path: string }) => module.path)).toEqual([
    "packages/x/src/lonely.ts",
  ]);
  expect(report.unused.map((entry: { name: string }) => entry.name)).toEqual(["lonely"]);
});

test("a work tree with no candidate source is refused rather than reported clean", () => {
  repo.seed({ "README.md": "# Repo\n" });
  const result = repo.run([process.execPath, script]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no apps/*/src or packages/*/src TypeScript");
  expect(result.stderr).not.toContain("    at ");
});

test("running outside a git work tree is refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "coforge-audit-"));
  try {
    const result = Bun.spawnSync([process.execPath, script], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("run this inside a git work tree");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing git is named as such, not as a missing work tree", () => {
  repo.seed({ "packages/x/src/lonely.ts": "export const lonely = 1;\n" });
  // An empty PATH is not enough: the OS falls back to its default search path, which has git.
  const withoutGit = mkdtempSync(join(tmpdir(), "coforge-audit-path-"));
  try {
    const result = repo.run([process.execPath, script], { PATH: withoutGit });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git is not on PATH");
  } finally {
    rmSync(withoutGit, { recursive: true, force: true });
  }
});
