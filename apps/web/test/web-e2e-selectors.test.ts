import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The browser e2es select the pages they test with aria-label and data-attribute selectors. When a
 * revamp restructures that DOM (task #30 split the Activity list into per-section lists), every
 * file carrying a copy of the old selector breaks silently - nothing in per-commit CI runs the
 * e2es to notice. The rule this guards: the shared helpers under `test/helpers/` own the page
 * structure selectors, e2e files import them, and a selector a revamp retired stays retired.
 */
const testsDir = join(import.meta.dir);

const e2eFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".e2e.ts"))
  .map((name) => ({ name, source: readFileSync(join(testsDir, name), "utf8") }));

const helperSource = readFileSync(join(testsDir, "helpers/activity-inbox-e2e.ts"), "utf8");

test("the Activity list's rows selector is defined once, in the shared helper", () => {
  // The row selectors live in the helper (rightClickRow, currentRow and every importing file
  // share one definition); a local copy drifts the next time the DOM moves.
  expect(helperSource).toContain("export const rowItems = JSON.stringify(");
  for (const { name, source } of e2eFiles)
    expect(
      source,
      `${name} redefines the shared rows selector; import it from helpers/`,
    ).not.toContain("const rowItems = JSON.stringify(");
});

test("a selector a revamp retired stays out of the e2es", () => {
  // Task #30 replaced the Activity page's single ol[aria-label="Activity"] with per-section
  // lists; after hydration nothing answers to that label, and a reintroduced copy matches
  // nothing (an assertion over an empty collection, which bun reports as a confusing pass).
  for (const { name, source } of e2eFiles)
    expect(
      source.includes('aria-label="Activity"') || helperSource.includes('aria-label="Activity"'),
      `${name} selects the retired Activity list label; aim it at the section or the list column`,
    ).toBe(false);
});
