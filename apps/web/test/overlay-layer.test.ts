import { expect, test } from "bun:test";

import {
  composeOverlayRefs,
  hasFollowingOverlayHost,
  hasPrecedingModalHost,
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

test("hasPrecedingModalHost detects outer modal hosts before a host and ignores later ones", () => {
  const makeChild = (kind: string | null) =>
    ({
      getAttribute(name: string) {
        return name === "data-overlay-host" ? kind : null;
      },
    }) as unknown as Element;

  const appRoot = makeChild(null);
  const slideoutHost = makeChild("modal");
  const pageModalHost = makeChild("page-flow");
  const childConfirmHost = makeChild("modal");

  expect(hasPrecedingModalHost(pageModalHost, [appRoot, pageModalHost, childConfirmHost])).toBe(
    false,
  );
  expect(hasPrecedingModalHost(pageModalHost, [appRoot, slideoutHost, pageModalHost])).toBe(true);
  expect(hasPrecedingModalHost(null, [appRoot, slideoutHost])).toBe(true);
  expect(hasPrecedingModalHost(null, [appRoot, pageModalHost])).toBe(false);
});

test("hasFollowingOverlayHost detects overlay hosts stacked after a host", () => {
  const makeChild = (kind: string | null) =>
    ({
      hasAttribute(name: string) {
        return name === "data-overlay-host" && kind !== null;
      },
    }) as unknown as Element;

  const appRoot = makeChild(null);
  const slideoutHost = makeChild("modal");
  const pageModalHost = makeChild("page-flow");
  const childConfirmHost = makeChild("modal");

  expect(hasFollowingOverlayHost(pageModalHost, [appRoot, pageModalHost, childConfirmHost])).toBe(
    true,
  );
  expect(hasFollowingOverlayHost(pageModalHost, [appRoot, slideoutHost, pageModalHost])).toBe(
    false,
  );
  expect(hasFollowingOverlayHost(null, [appRoot, slideoutHost])).toBe(false);
});
