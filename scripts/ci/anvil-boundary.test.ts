import { expect, test } from "bun:test";
import { dirname, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../..");
const anvil = resolve(root, "packages/anvil");
const daemon = resolve(root, "packages/daemon");
const pi = resolve(anvil, "src/pi");

// Scan specifiers before transpilation so type-only imports and re-exports count too.
// This intentionally enforces dependency direction for the library, not its host-side tests.
test("Anvil cannot import daemon orchestration or platform implementations", async () => {
  const violations: string[] = [];
  const piViolations: string[] = [];
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
          : undefined;
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
});
