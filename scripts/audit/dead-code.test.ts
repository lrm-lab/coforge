import { expect, test } from "bun:test";
import {
  analyze,
  declaredExports,
  functionBodies,
  importedStems,
  isCandidatePath,
  renderMarkdown,
} from "./dead-code";

const longBody = `  const value = input.trim();
  if (value.length === 0) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);`;

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

test("only product and package source is a candidate", () => {
  expect(isCandidatePath("packages/x/src/a.ts")).toBe(true);
  expect(isCandidatePath("apps/web/src/server/a.ts")).toBe(true);
  expect(isCandidatePath("packages/x/src/index.ts")).toBe(false);
  expect(isCandidatePath("apps/web/src/routes/a.tsx")).toBe(false);
  expect(isCandidatePath("packages/x/src/a.test.ts")).toBe(false);
  expect(isCandidatePath("apps/web/src/generated/prisma/client.ts")).toBe(false);
  expect(isCandidatePath("packages/x/src/a_pb.ts")).toBe(false);
});

test("an export nothing else names is reported, a referenced one is not", () => {
  const report = analyze(
    new Map([
      [
        "packages/x/src/a.ts",
        ["export function unused() {}", "export function used() {}"].join("\n"),
      ],
      ["packages/x/src/b.ts", "import { used } from './a';\nused();"],
    ]),
  );
  expect(report.exports.map((entry) => entry.name)).toEqual(["unused"]);
  expect(report.exports[0]).toMatchObject({ path: "packages/x/src/a.ts", line: 1 });
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

test("a module the build names by its path is not orphaned", () => {
  const report = analyze(
    new Map([
      ["apps/web/src/server/plugin.server.ts", "export const plugin = 1;"],
      ["apps/web/vite.config.ts", "export default { plugins: ['#src/server/plugin.server'] };"],
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

test("function bodies carry their name and line", () => {
  expect(functionBodies("export async function go() {\n  return 1;\n}\n")).toEqual([
    { name: "go", line: 1, body: "return 1;" },
  ]);
});

test("import stems name the imported module", () => {
  expect(importedStems("import { a } from './alpha';\nimport('./beta');")).toEqual([
    "alpha",
    "beta",
  ]);
});

test("the report names each section with its count", () => {
  const markdown = renderMarkdown({
    files: 3,
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
  expect(markdown).toContain("## Modules nothing imports (1)");
  expect(markdown).toContain("`packages/x/src/lonely.ts` (4 lines)");
  expect(markdown).toContain("## Exports nothing references (1)");
  expect(markdown).toContain("`unused` - `packages/x/src/a.ts:2`");
  expect(markdown).toContain("## Identical function bodies in more than one file (1)");
  expect(markdown).toContain("`parse` (2 copies)");
});
