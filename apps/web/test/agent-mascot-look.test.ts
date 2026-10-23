import { expect, test } from "bun:test";

import { LOOK_FULL_DISTANCE_PX, lookToward } from "#src/features/agents/mascot-look";

// Frank, 2026-10-24: an Agent's mascot looks at the cursor. `lookToward` maps the pointer's
// offset from the mascot's centre (pixels) to the `lookX` / `lookY` the Rive file takes, each in
// [-1, 1], 0 straight ahead, +x right, +y down.
test("a pointer at the mascot's centre, or an unknown one, looks straight ahead", () => {
  expect(lookToward(0, 0)).toEqual({ x: 0, y: 0 });
  expect(lookToward(Number.NaN, 5)).toEqual({ x: 0, y: 0 });
  expect(lookToward(4, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
});

test("the look points at the pointer along each axis", () => {
  const far = LOOK_FULL_DISTANCE_PX;
  expect(lookToward(far, 0)).toEqual({ x: 1, y: 0 });
  expect(lookToward(-far, 0)).toEqual({ x: -1, y: 0 });
  expect(lookToward(0, far).y).toBe(1);
  expect(lookToward(0, -far).y).toBe(-1);
});

test("the deflection saturates at the full distance and never exceeds one", () => {
  const far = lookToward(LOOK_FULL_DISTANCE_PX * 20, -LOOK_FULL_DISTANCE_PX * 20);
  expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 10);
  expect(far.x).toBeGreaterThan(0);
  expect(far.y).toBeLessThan(0);
  expect(far.x).toBeCloseTo(-far.y, 10);
});

test("the deflection grows with distance, softly, and keeps the direction", () => {
  const sizes = [20, 60, 120, 200, 280].map((d) => lookToward(d * 0.6, d * 0.8));
  const lengths = sizes.map(({ x, y }) => Math.hypot(x, y));
  for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThan(lengths[i - 1]!);
  for (const { x, y } of sizes) expect(y / x).toBeCloseTo(0.8 / 0.6, 10);
  // Soft: half the full distance is already most of the way, and the approach to full flattens.
  const half = lookToward(LOOK_FULL_DISTANCE_PX / 2, 0).x;
  expect(half).toBeGreaterThan(0.5);
  expect(half).toBeLessThan(0.95);
  const near = lookToward(LOOK_FULL_DISTANCE_PX - 30, 0).x;
  expect(1 - near).toBeLessThan(0.02);
});
