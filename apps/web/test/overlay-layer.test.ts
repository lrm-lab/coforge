import { expect, test } from "bun:test";

import {
  composeOverlayRefs,
  OVERLAY_CONTENT_Z,
  OVERLAY_LAYER,
  OVERLAY_SCRIM_Z,
} from "#src/lib/overlay-layer";

test("keeps scrim strictly below overlay content within the shared z-50 layer", () => {
  expect(OVERLAY_LAYER).toBe("z-50");
  expect(OVERLAY_SCRIM_Z).toBeLessThan(OVERLAY_CONTENT_Z);
});

test("composeOverlayRefs forwards attach and detach to both internal and external refs", () => {
  const internal: Array<string | null> = [];
  const externalFn: Array<string | null> = [];
  const externalObj: { current: string | null } = { current: null };

  const mergedFn = composeOverlayRefs<string>(
    (node) => {
      externalFn.push(node);
    },
    (node) => internal.push(node),
  );
  mergedFn("overlay-1");
  mergedFn(null);
  expect(internal).toEqual(["overlay-1", null]);
  expect(externalFn).toEqual(["overlay-1", null]);

  const mergedObj = composeOverlayRefs<string>(externalObj, (node) => internal.push(node));
  mergedObj("overlay-2");
  expect(externalObj.current).toBe("overlay-2");
  mergedObj(null);
  expect(externalObj.current).toBeNull();
});
