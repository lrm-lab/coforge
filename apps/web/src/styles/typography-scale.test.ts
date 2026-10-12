import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

/** Product code writes text with the type scale and its tokens, never with an arbitrary value.
 *
 * Sizes: `docs/design/typography.md` has exactly one scale, so `text-[0.6875rem]` is a deviation by
 * definition — there is no "the mockup says 11px" escape: an eleventh size means adding a token
 * first. Two such values reached a review round in the Computer Agent sections before this gate.
 *
 * Colours: `text-[#101319]` and `text-[var(--x)]` match the same pattern, on purpose — a hardcoded
 * value is what `docs/design-tokens.md` section 6 asks product code not to write.
 *
 * Geometry is deliberately out of scope, measured rather than asserted: of the 44 arbitrary size
 * values in product code (vendor Untitled directories excluded), 41 are mockup-measured geometry —
 * `rounded-[10px]`, `border-[3px]`, `size-[9px]` — which the design rules allow, so a gate over
 * them would carry a whitelist longer than the rule it guards.
 *
 * All of `features/landing` is exempt, not just its fluid `clamp()`: the public page is a visually
 * frozen layer with its own Base UI controls and its own isolated variables
 * (`docs/design-tokens.md` section 4), so it never took the product's typography scale. Keep the
 * whole directory excluded rather than narrowing this to the lines that happen to use `clamp()`
 * today. */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["features", "routes", "components/ui", "components/layout"];
const EXEMPT = [join("features", "landing")];
const ARBITRARY_TEXT = /\btext-\[[^\]]*\]/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("product code uses the type scale and its tokens, not arbitrary text values", () => {
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
  expect(
    offenders,
    "size: a step from docs/design/typography.md; colour: a semantic token",
  ).toEqual([]);
});
