import { expect, test } from "bun:test";

import { lightboxStepTarget } from "#src/features/conversations/image-lightbox-step";
import { galleryRows, imageShape, singleImageBox } from "#src/lib/attachment-image-box";

const size = (imageWidth: number, imageHeight: number) => ({ imageWidth, imageHeight });

test("a lone image keeps its ratio within 360×288 and is never enlarged", () => {
  expect(singleImageBox(size(4032, 3024))).toEqual({
    width: "min(360px, 100%)",
    aspectRatio: "4032 / 3024",
  });
  expect(singleImageBox(size(1170, 7956))).toEqual({
    width: "min(42px, 100%)",
    aspectRatio: "1170 / 7956",
  });
  expect(singleImageBox(size(300, 200)).width).toBe("min(300px, 100%)");
  expect(singleImageBox(size(2000, 100)).width).toBe("min(360px, 100%)");
});

test("a lone image without a known size gets a 176-wide 4:3 box", () => {
  expect(singleImageBox({})).toEqual({ width: "min(176px, 100%)", aspectRatio: "4 / 3" });
  expect(singleImageBox(size(0, 10))).toEqual({ width: "min(176px, 100%)", aspectRatio: "4 / 3" });
});

test("2.2:1 and wider is wide, 0.55:1 and narrower is tall, an unknown size is normal", () => {
  expect(imageShape(size(220, 100))).toBe("wide");
  expect(imageShape(size(219, 100))).toBe("normal");
  expect(imageShape(size(55, 100))).toBe("tall");
  expect(imageShape(size(56, 100))).toBe("normal");
  expect(imageShape({})).toBe("normal");
});

test("four images go two and two; five go three and two", () => {
  const normal = size(400, 300);
  expect(
    galleryRows([normal, normal, normal, normal]).map((row) => row.map((cell) => cell.index)),
  ).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(
    galleryRows([normal, normal, normal, normal, normal]).map((row) =>
      row.map((cell) => cell.index),
    ),
  ).toEqual([
    [0, 1, 2],
    [3, 4],
  ]);
});

test("a wide image takes its own row and splits the run around it; only normal ones fill", () => {
  const rows = galleryRows([size(400, 300), size(100, 400), size(1000, 100), size(400, 300)]);
  expect(rows).toEqual([
    [
      { index: 0, fit: "cover" },
      { index: 1, fit: "contain" },
    ],
    [{ index: 2, fit: "contain" }],
    [{ index: 3, fit: "cover" }],
  ]);
});

test("the gallery's photos: a 4:3 landscape fills 360×270, a long screenshot is a sliver", () => {
  expect(singleImageBox(size(1200, 900)).width).toBe("min(360px, 100%)");
  // 300×2000 is tall: 288 high, so 43px wide (286.7 tall).
  expect(singleImageBox(size(300, 2000)).width).toBe("min(43px, 100%)");
  expect(imageShape(size(300, 2000))).toBe("tall");
});

test("five with a wide one in the middle go two, the wide one alone, then two", () => {
  const rows = galleryRows([
    size(400, 300),
    size(400, 300),
    size(1000, 200),
    size(400, 300),
    size(100, 400),
  ]);
  expect(rows.map((row) => row.map((cell) => cell.index))).toEqual([[0, 1], [2], [3, 4]]);
});

test("an SVG has no pixel size: a 24px icon grows to 176, a banner still fits 360 (task #131)", () => {
  const svg = (width: number, height: number) => ({
    ...size(width, height),
    contentType: "image/svg+xml",
  });
  expect(singleImageBox(svg(24, 24)).width).toBe("min(176px, 100%)");
  expect(singleImageBox(svg(800, 400)).width).toBe("min(360px, 100%)");
  // A photo of the same size is never enlarged.
  expect(singleImageBox(size(24, 24)).width).toBe("min(24px, 100%)");
  // In a grid an SVG is shown whole, a photo of the same shape fills its cell.
  expect(
    galleryRows([svg(300, 300), size(300, 300)])
      .flat()
      .map((cell) => cell.fit),
  ).toEqual(["contain", "cover"]);
});

test("the lightbox steps one image at a time and stops at the ends instead of wrapping", () => {
  expect(lightboxStepTarget(0, -1, 5)).toBeUndefined();
  expect(lightboxStepTarget(0, 1, 5)).toBe(1);
  expect(lightboxStepTarget(2, -1, 5)).toBe(1);
  expect(lightboxStepTarget(4, 1, 5)).toBeUndefined();
  expect(lightboxStepTarget(4, -1, 5)).toBe(3);
});
