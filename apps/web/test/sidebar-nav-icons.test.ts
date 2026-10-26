/**
 * Left-navigation items follow the design spec: a resting label and icon draw in the
 * `--color-nav-fg` token (#777D8D in light, lightened in dark) with a 2px stroke, and the current
 * item in `--color-nav-fg-current` (#101319, the sidebar ink).
 */
import { expect, test } from "bun:test";

test("The resting token carries the spec's value in light, and a lighter one for the dark column", async () => {
  const css = await Bun.file(new URL("../src/styles/coforge-theme.css", import.meta.url)).text();
  const values = [...css.matchAll(/--color-nav-fg:\s*([^;]+);/g)].map((hit) =>
    hit[1]!.trim().toLowerCase(),
  );
  // The spec's cool grey is the light value; dark re-points it, because this one drops to
  // 4.4:1 on the dark sidebar and reads muddy next to the current item's accent.
  expect(values[0]).toBe("#777d8d");
  expect(values).toHaveLength(2);
  expect(values[1]).not.toBe("#777d8d");
});
