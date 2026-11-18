import { expect, test } from "bun:test";

import { desktopLandscapeFrameStyle } from "#src/features/computers/desktop-landscape";

test("landscape frame swaps the viewport axes and rotates clockwise from the top-left", () => {
  const style = desktopLandscapeFrameStyle();
  expect(style.width).toBe("100dvh");
  expect(style.height).toBe("100dvw");
  expect(style.transform).toBe("rotate(90deg) translateY(-100%)");
  expect(style.transformOrigin).toBe("top left");
  expect(style.position).toBe("fixed");
  expect(style.top).toBe(0);
  expect(style.left).toBe(0);
});
