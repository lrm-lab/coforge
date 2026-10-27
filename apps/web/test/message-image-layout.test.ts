import { expect, test } from "bun:test";

import { galleryRows, imageShape, singleImageBox } from "#src/lib/attachment-image-box";

const size = (imageWidth: number, imageHeight: number) => ({ imageWidth, imageHeight });

test("a lone image keeps its ratio within 416×288 and is never enlarged", () => {
  expect(singleImageBox(size(4032, 3024))).toEqual({
    width: "min(384px, 100%)",
    aspectRatio: "4032 / 3024",
  });
  expect(singleImageBox(size(1170, 7956))).toEqual({
    width: "min(42px, 100%)",
    aspectRatio: "1170 / 7956",
  });
  expect(singleImageBox(size(300, 200)).width).toBe("min(300px, 100%)");
  expect(singleImageBox(size(2000, 100)).width).toBe("min(416px, 100%)");
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
