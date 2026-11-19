import { expect, test } from "bun:test";
import {
  clampPhoneFabPosition,
  defaultPhoneFabPosition,
} from "#src/host/desktop-phone-fab-position";

test("clamp keeps a mid-screen FAB where it is", () => {
  expect(clampPhoneFabPosition(100, 200, 390, 844, 48, 48)).toEqual({ left: 100, top: 200 });
});

test("clamp pulls a FAB back when the viewport shrinks like fake landscape", () => {
  // Portrait drag near the bottom, then iframe becomes short (100dvw ≈ phone width).
  expect(clampPhoneFabPosition(100, 700, 844, 390, 48, 48)).toEqual({ left: 100, top: 342 });
});

test("clamp pulls a FAB back when it sits past the right edge", () => {
  expect(clampPhoneFabPosition(900, 10, 844, 390, 48, 48)).toEqual({ left: 796, top: 10 });
});

test("default FAB rests at the bottom-right of the current viewport", () => {
  expect(defaultPhoneFabPosition(390, 844, 48, 48)).toEqual({ left: 328, top: 778 });
  expect(defaultPhoneFabPosition(844, 390, 48, 48)).toEqual({ left: 782, top: 324 });
});
