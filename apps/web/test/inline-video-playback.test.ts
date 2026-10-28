import { expect, test } from "bun:test";

import {
  inlineVideoBox,
  inlineVideoErrorOutcome,
} from "#src/features/conversations/inline-video-playback";

test("a video is boxed as a lone image once its size is known, 16:9 until then", () => {
  expect(inlineVideoBox()).toEqual({ width: "min(360px, 100%)", aspectRatio: "16 / 9" });
  expect(inlineVideoBox({ width: 1280, height: 720 })).toEqual({
    width: "min(360px, 100%)",
    aspectRatio: "1280 / 720",
  });
});

test("a portrait clip is widened for its controls and letterboxed within the image height", () => {
  expect(inlineVideoBox({ width: 1080, height: 1920 })).toEqual({
    width: "min(240px, 100%)",
    aspectRatio: "240 / 288",
  });
  expect(inlineVideoBox({ width: 200, height: 150 })).toEqual({
    width: "min(240px, 100%)",
    aspectRatio: "240 / 180",
  });
});

test("an error tries the fallback first: an expired signed URL fails like an unreadable file", () => {
  expect(
    inlineVideoErrorOutcome({ code: 4, hasFallback: true, metadataLoaded: false, online: true }),
  ).toBe("fallback");
});

test("a file the browser cannot read the start of is a format it cannot play", () => {
  for (const code of [3, 4])
    expect(
      inlineVideoErrorOutcome({ code, hasFallback: false, metadataLoaded: false, online: true }),
    ).toBe("unsupported");
});

test("a network error, a failure mid-way or one while offline is a load failure", () => {
  expect(
    inlineVideoErrorOutcome({ code: 2, hasFallback: false, metadataLoaded: false, online: true }),
  ).toBe("failed");
  expect(
    inlineVideoErrorOutcome({ code: 4, hasFallback: false, metadataLoaded: true, online: true }),
  ).toBe("failed");
  expect(
    inlineVideoErrorOutcome({ code: 4, hasFallback: false, metadataLoaded: false, online: false }),
  ).toBe("failed");
});
