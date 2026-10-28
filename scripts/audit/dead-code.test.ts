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

test("a declaration is found with the line it starts on", () => {
  const text = [
    "import { x } from './x';",
    "",
    "export function alpha() {}",
    "export const beta = 1;",
  ].join("\n");
  expect(declaredExports(text)).toEqual([
    { name: "alpha", line: 3 },
    { name: "beta", line: 4 },
  ]);
});

test("a const enum is one declaration, not a declaration named enum", () => {
  expect(declaredExports("export const enum Mode {\n  A,\n}\n")).toEqual([
    { name: "Mode", line: 1 },
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

test("an export only its own file uses is dead, one another file references is not", () => {
  const report = analyze(
    new Map([
      [
        "packages/x/src/a.ts",
        ["export function unused() {}", "export function used() {}", "used();"].join("\n"),
      ],
      ["packages/x/src/b.ts", "import { used } from './a';\nused();"],
    ]),
  );
  expect(report.exports.map((entry) => entry.name)).toEqual(["unused"]);
  expect(report.exports[0]).toMatchObject({ path: "packages/x/src/a.ts", line: 1 });
});

test("two dead declarations of one name are both reported", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/a.ts", "export function twin() {}"],
      ["packages/x/src/b.ts", "export function twin() {}"],
    ]),
  );
  expect(report.exports.map((entry) => `${entry.name}@${entry.path}`)).toEqual([
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

test("a bare side-effect import still names its module", () => {
  const report = analyze(
    new Map([
      ["packages/x/src/register.ts", "export const a = 1;"],
      ["apps/web/src/consumer.ts", "import './register';"],
    ]),
  );
  expect(report.modules.map((module) => module.path)).not.toContain("packages/x/src/register.ts");
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

test("a brace inside a string or a comment does not cut the body short", () => {
  const body = [
    "export function payload() {",
    '  const json = "}";',
    "  // } a comment brace",
    "  const text = `${json} }`;",
    `  const filler = "${"x".repeat(140)}";`,
    "  return 1;",
    "}",
  ].join("\n");
  const [parsed] = functionBodies(body);
  expect(parsed!.body.endsWith("return 1;")).toBe(true);
  expect(parsed!.body.length).toBeGreaterThan(140);
  expect(parsed!.line).toBe(1);
});

test("noise stripping keeps every newline and every code character", () => {
  const text = 'const a = "x\\ny";\n// comment\nconst b = `z`;\n';
  const stripped = stripNoise(text);
  expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
  expect(stripped).toContain("const a =");
  expect(stripped).toContain("const b =");
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
    exports: [{ name: "unused", path: "packages/x/src/a.ts", line: 2 }],
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
  expect(markdown).toContain("## Exports nothing outside their own file references (1)");
  expect(markdown).toContain("`unused` - `packages/x/src/a.ts:2`");
  expect(markdown).toContain("## Identical function bodies in more than one file (1)");
  expect(markdown).toContain("`parse` (2 copies)");
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
});

test("a work tree with no candidate source is refused rather than reported clean", () => {
  repo.seed({ "README.md": "# Repo\n" });
  const result = repo.run([process.execPath, script]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no apps/*/src or packages/*/src TypeScript");
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
