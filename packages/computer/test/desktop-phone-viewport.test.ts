import { expect, test } from "bun:test";
import {
  clampPhoneScale,
  phoneCanvasLocalPoint,
  phoneFitScale,
  phoneGestureIsTap,
  phoneScaleFromPinch,
  phoneViewportCanPan,
  phoneViewportSize,
} from "#src/host/desktop-phone-viewport";

test("fit scale never exceeds 1:1", () => {
  expect(phoneFitScale(390, 844, 1920, 1080)).toBeCloseTo(390 / 1920, 5);
  expect(phoneFitScale(2000, 2000, 800, 600)).toBe(1);
});

test("clamp keeps zoom between fit and 1:1", () => {
  const fit = 0.3;
  expect(clampPhoneScale(0.1, fit)).toBe(fit);
  expect(clampPhoneScale(0.5, fit)).toBe(0.5);
  expect(clampPhoneScale(2, fit)).toBe(1);
});

test("pinch scales continuously from the start scale and distance", () => {
  expect(phoneScaleFromPinch(0.4, 100, 150, 0.3)).toBeCloseTo(0.6, 5);
  expect(phoneScaleFromPinch(0.4, 100, 50, 0.3)).toBe(0.3);
  expect(phoneScaleFromPinch(0.8, 100, 200, 0.3)).toBe(1);
});

test("panning is available only when zoomed past fit", () => {
  expect(phoneViewportCanPan(0.3, 0.3)).toBe(false);
  expect(phoneViewportCanPan(0.5, 0.3)).toBe(true);
  expect(phoneViewportCanPan(1, 0.3)).toBe(true);
});

test("viewport size is the container divided by CSS scale", () => {
  expect(phoneViewportSize(390, 844, 0.5)).toEqual({ width: 780, height: 1688 });
  expect(phoneViewportSize(390, 844, 1)).toEqual({ width: 390, height: 844 });
  const fit = phoneFitScale(390, 844, 1920, 1080);
  const atFit = phoneViewportSize(390, 844, fit);
  expect(atFit.width).toBeCloseTo(1920, 5);
  expect(atFit.height).toBeGreaterThanOrEqual(1080);
});

test("mouse points stay in canvas CSS pixels for RFB", () => {
  expect(phoneCanvasLocalPoint(150, 240, 100, 200)).toEqual({ x: 50, y: 40 });
});

test("small finger travel still counts as a tap when zoomed", () => {
  expect(phoneGestureIsTap(0, 0)).toBe(true);
  expect(phoneGestureIsTap(10, 10)).toBe(true);
  expect(phoneGestureIsTap(30, 0)).toBe(false);
});
