import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bun's `mock.module` replaces a module for the rest of the `bun test` process; `mock.restore()`
// does not undo it. A raw call therefore leaks its stub into every later test file — which is how
// 43 tests and two "Export named … not found" errors failed only in full runs before #191.
// `test/helpers/file-module-mock.ts` (`mockModuleForFile`) keeps the real exports under the stub and
// puts the real module back after the file, so it is the one place allowed to call `mock.module`.
const repoRoot = join(import.meta.dir, "..", "..", "..");
const HELPER = "apps/web/test/helpers/file-module-mock.ts";
const rawCall = /\bmock\.module\s*\(/;

// The web package's own `bun test` process. Other packages run their own, outside this helper's
// reach (`packages/computer/test/installer-launch.test.ts` stubs `node:fs/promises` there, spread
// over the real module so every unarmed call still reaches the real file system).
const EXTENSIONS = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const SCANNED = [
  `apps/web/src/**/*.${EXTENSIONS}`,
  `apps/web/test/**/*.${EXTENSIONS}`,
  `apps/web/prisma/**/*.${EXTENSIONS}`,
];

function filesCallingMockModule(): string[] {
  return SCANNED.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })])
    .filter((file) => !file.includes("node_modules"))
    .filter((file) => rawCall.test(readFileSync(join(repoRoot, file), "utf8")))
    .sort();
}

test("only mockModuleForFile calls mock.module directly", () => {
  // No other exemption, this file included: its pattern and prose do not match `rawCall`.
  expect(filesCallingMockModule().filter((file) => file !== HELPER)).toEqual([]);
});

test("the scan finds the helper, so an empty result above is not a broken glob", () => {
  expect(filesCallingMockModule()).toContain(HELPER);
});
