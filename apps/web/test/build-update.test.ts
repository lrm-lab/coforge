import { expect, test } from "bun:test";

import {
  buildUpdateStateAfterProbe,
  hasUnsavedTemporaryState,
  isChunkLoadError,
  registerUnsavedTemporaryState,
} from "#src/features/updates/build-update";

test("a server version that differs from the build value detects an update", () => {
  expect(buildUpdateStateAfterProbe({ updateDetected: false }, "old", "new")).toEqual({
    updateDetected: true,
  });
});

test("an update stays detected when a rolling deployment answers with the old version again", () => {
  const detected = buildUpdateStateAfterProbe({ updateDetected: false }, "old", "new");
  expect(buildUpdateStateAfterProbe(detected, "old", "old")).toEqual({ updateDetected: true });
});

test("a matching server version does not detect an update", () => {
  expect(buildUpdateStateAfterProbe({ updateDetected: false }, "same", "same")).toEqual({
    updateDetected: false,
  });
});

test("chunk and dynamic import failures are update errors, but ordinary errors are not", () => {
  expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
  expect(isChunkLoadError(new Error("Loading chunk 7 failed"))).toBe(true);
  expect(isChunkLoadError(new Error("chunk upload failed"))).toBe(false);
  expect(isChunkLoadError(new Error("Request failed"))).toBe(false);
});

test("unsaved temporary state is registered and released by its owner", () => {
  expect(hasUnsavedTemporaryState()).toBe(false);
  const release = registerUnsavedTemporaryState(true);
  expect(hasUnsavedTemporaryState()).toBe(true);
  release();
  expect(hasUnsavedTemporaryState()).toBe(false);
});
