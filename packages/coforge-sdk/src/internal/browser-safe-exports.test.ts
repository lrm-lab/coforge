import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `@lrm/coforge-sdk/internal` and `/agent` barrels are imported by the Web app's browser
 * code. A module they reach that imports a `node:`/`bun:` builtin breaks the browser bundle —
 * Vite dev cannot resolve it and the page never hydrates (task #417 follow-up: computer-credentials
 * did exactly that through `node:path`). Node-only helpers belong on an `internal/<name>` subpath
 * that only Node consumers import. This walks each barrel's import graph — `./` relatives and the
 * package's `#src/` alias — and fails on the first builtin import it reaches.
 */
const SDK_SRC = join(import.meta.dir, "..");
const BANNED = /(?:from|import)\s*\(?\s*["'`](?:node|bun):/;

async function reachableFiles(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = await readFile(file, "utf8").catch(() => undefined);
    if (source === undefined) continue;
    seen.add(file);
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      let target: string | undefined;
      if (specifier.startsWith("./")) {
        // ESM specifiers may carry a `.js` that Bun/TS resolve to the `.ts` source.
        target = join(file, "..", `${specifier.slice(2).replace(/\.js$/, "")}.ts`);
      } else if (specifier.startsWith("#src/")) {
        target = join(SDK_SRC, `${specifier.slice(5).replace(/\.js$/, "")}.ts`);
      }
      if (target) queue.push(target);
    }
  }
  return [...seen];
}

test("the internal and agent barrels reach no node:/bun: builtin", async () => {
  const offenders: string[] = [];
  for (const barrel of ["internal/index.ts", "agent/index.ts"]) {
    for (const file of await reachableFiles(join(SDK_SRC, barrel))) {
      if (file.endsWith(".test.ts")) continue;
      if (BANNED.test(await readFile(file, "utf8"))) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
