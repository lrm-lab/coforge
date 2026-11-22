import { afterEach, expect, test } from "bun:test";

import {
  hasFailedImageUrl,
  markFailedImageUrl,
  resetFailedImageUrlsForTest,
} from "#src/hooks/use-image-fallback";

afterEach(() => {
  resetFailedImageUrlsForTest();
});

test("tracks broken image URLs across fallback consumers", () => {
  expect(hasFailedImageUrl("/avatars/missing.png")).toBe(false);
  markFailedImageUrl("/avatars/missing.png");
  expect(hasFailedImageUrl("/avatars/missing.png")).toBe(true);
  resetFailedImageUrlsForTest();
  expect(hasFailedImageUrl("/avatars/missing.png")).toBe(false);
});
