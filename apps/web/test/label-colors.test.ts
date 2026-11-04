import { expect, test } from "bun:test";
import { LABEL_COLORS } from "#src/server/tasks/labels.server";
import { LABEL_COLOR_KEYS, LABEL_PALETTE, newLabelColor } from "#src/features/tasks/label-colors";

test("the colors the client draws are the colors the server accepts", () => {
  expect([...LABEL_COLOR_KEYS].sort()).toEqual([...LABEL_COLORS].sort());
});

test("the palette is a subset of them, without slate and brand, and a new label's default is in it", () => {
  for (const color of LABEL_PALETTE) expect(LABEL_COLORS as readonly string[]).toContain(color);
  expect(LABEL_PALETTE.length).toBe(10);
  for (const name of ["Bug", "Design", "Motion 123", "标签", ""]) {
    const color = newLabelColor(name);
    expect(LABEL_PALETTE).toContain(color);
    expect(color).not.toBe("gray");
    expect(newLabelColor(` ${name.toUpperCase()} `)).toBe(color);
  }
});
