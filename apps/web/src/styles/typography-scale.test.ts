import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

/** Product code sizes text on the type scale, never with an arbitrary value.
 *
 * `docs/design/typography.md` has exactly one scale, so `text-[0.6875rem]` is a deviation by
 * definition — there is no "the mockup says 11px" escape: an eleventh size means adding a token
 * first. Geometry is deliberately out of scope: `rounded-[10px]`, `border-[3px]`, `[400px]` and
 * its relatives are measured off a mockup, the design rules allow that, and a gate over them would
 * need a whitelist longer than the rule.
 *
 * Geometry is out of scope for a reason worth measuring rather than asserting: of the 44 arbitrary
 * size values in product code (excluding the vendor Untitled directories), 41 are mockup-measured
 * geometry, so a gate over them would carry a whitelist longer than the rule it guards.
 *
 * All of `features/landing` is exempt, not just its fluid `clamp()`: the public page is a visually
 * frozen layer with its own Base UI controls and its own isolated variables
 * (`docs/design-tokens.md` section 4), so it never took the product's typography scale. Keep the
 * whole directory excluded rather than narrowing this to the lines that happen to use `clamp()`
 * today. */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["features", "routes", "components/ui"];
const EXEMPT = [join("features", "landing")];
const ARBITRARY_TEXT = /\btext-\[[^\]]*\]/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("no arbitrary font size in product code", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of files(join(SRC, root))) {
      const path = relative(SRC, file);
      if (EXEMPT.some((exempt) => path.startsWith(`${exempt}/`))) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const hits = line.match(ARBITRARY_TEXT);
          if (hits) offenders.push(`${path}:${index + 1}: ${hits.join(", ")}`);
        });
    }
  }
  expect(offenders, "use a step from docs/design/typography.md").toEqual([]);
});
