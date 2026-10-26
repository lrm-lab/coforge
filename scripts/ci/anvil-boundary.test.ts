import { expect, test } from "bun:test";
import { dirname, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../..");
const anvil = resolve(root, "packages/anvil");
const daemon = resolve(root, "packages/daemon");
const pi = resolve(anvil, "src/pi");
const runtimes = ["cursor", "opencode", "kiro", "grok", "antigravity", "pi", "dsh"].map((name) =>
  resolve(anvil, "src", name),
);
const execution = ["execution", "jsonl-process", "process-tree-cleanup"].map((name) =>
  resolve(anvil, "src", name),
);
const perTurn = resolve(anvil, "src/per-turn");

function isImplementation(path: string): boolean {
  return (
    runtimes.some((directory) => path === directory || path.startsWith(directory + sep)) ||
    execution.some((file) => path === file || path === file + ".ts") ||
    path === perTurn ||
    path.startsWith(perTurn + sep)
  );
}

// Scan specifiers before transpilation so type-only imports and re-exports count too.
// This intentionally enforces dependency direction for the library, not its host-side tests.
test("Anvil cannot import daemon orchestration or platform implementations", async () => {
  const violations: string[] = [];
  const piViolations: string[] = [];
  const implementationViolations: string[] = [];
  const paths = ["index.ts", ...(await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan(anvil)))];
  expect(paths.length, "The source scan must not silently skip Anvil").toBeGreaterThan(1);
  for (const path of paths) {
    const source = await Bun.file(resolve(anvil, path)).text();
    const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      const target = specifier.startsWith(".")
        ? resolve(anvil, dirname(path), specifier)
        : specifier.startsWith("#src/")
          ? resolve(anvil, "src", specifier.slice(5))
          : specifier.startsWith("@lrm/coforge-anvil/")
            ? resolve(anvil, "src", specifier.slice("@lrm/coforge-anvil/".length))
            : undefined;
      if (target && !isImplementation(resolve(anvil, path)) && isImplementation(target)) {
        implementationViolations.push(path + ": " + specifier);
      }
      if (
        !resolve(anvil, path).startsWith(pi + sep) &&
        (target === pi || target?.startsWith(pi + sep))
      ) {
        piViolations.push(path + ": " + specifier);
      }
      if (
        /^@(?:coforge\/daemon|lrm\/coforge-daemon)(?:\/|$)/.test(specifier) ||
        /^#src\/platform(?:\/|$)/.test(specifier) ||
        target === daemon ||
        target?.startsWith(`${daemon}${sep}`)
      ) {
        violations.push(`${path}: ${specifier}`);
      }
    }
  }
  expect(violations, "Inject host capabilities through Anvil ports instead").toEqual([]);
  expect(piViolations, "Keep embedded Pi behind the explicit /pi entry").toEqual([]);
  expect(
    implementationViolations,
    "Keep runtime and execution implementations out of provider-neutral modules",
  ).toEqual([]);
});
