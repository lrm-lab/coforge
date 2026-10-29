/**
 * Left-navigation items: a resting label and icon draw in the `--color-nav-fg` token (the tertiary
 * text grey in light, since the spec's #777D8D read as disabled; lightened in dark) with a 2px
 * stroke, and the current item in `--color-nav-fg-current` (#101319, the sidebar ink).
 */
import { expect, test } from "bun:test";

test("The resting token is the tertiary text grey in light, and a lighter one for the dark column", async () => {
  const css = await Bun.file(new URL("../src/styles/coforge-theme.css", import.meta.url)).text();
  const values = [...css.matchAll(/--color-nav-fg:\s*([^;]+);/g)].map((hit) =>
    hit[1]!.trim().toLowerCase(),
  );
  // Light reads the tertiary text grey; dark re-points it, because that drops too far on the dark
  // sidebar and reads muddy next to the current item's accent.
  expect(values[0]).toBe("var(--color-text-tertiary)");
  expect(values).toHaveLength(2);
  expect(values[1]).not.toBe(values[0]);
});
