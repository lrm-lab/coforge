import { expect, test } from "bun:test";

import { MASCOT_IDS } from "#src/features/agents/mascot-contract";

import { faceOrigin, facePlacement, inside, turn } from "../assets/mascots/face.ts";
import { loadSpec } from "../assets/mascots/spec.ts";
import { add, pathOutline, sub } from "../assets/mascots/svg-path.ts";

// Frank, 2026-10-23: at rest a mascot looks at the viewer, so the generator moves each face toward
// the middle of its body and turns it toward level (`face.ts`). Whatever the numbers, the placed
// face stays on the body and is never turned past level into the opposite tilt.
test("every placed face keeps both eyes on the body and turns no further than level", () => {
  for (const id of MASCOT_IDS) {
    const spec = loadSpec(id);
    const { shift, rotation } = facePlacement(spec);
    const origin = faceOrigin(spec);
    const body = pathOutline(spec.body.d, 8).flat();
    for (const eye of [spec.eyes.l, spec.eyes.r]) {
      const centre = add(add(origin, turn(sub(eye, origin), rotation)), shift);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 2 * Math.PI;
        const rim = add(centre, [Math.cos(a), Math.sin(a)], spec.eyes.radius);
        expect(inside(rim, body), `${id} eye rim at ${rim.join(",")}`).toBeTrue();
      }
    }
    const { l, r } = spec.eyes;
    const tilt = Math.atan2(r[1] - l[1], r[0] - l[0]);
    expect(Math.abs(rotation), id).toBeLessThanOrEqual(Math.abs(tilt));
    expect(Math.sign(rotation) * Math.sign(tilt), id).toBeLessThanOrEqual(0);
  }
});
