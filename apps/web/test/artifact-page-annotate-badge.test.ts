import { expect, test } from "bun:test";
import { ANNOTATE_DOM_SOURCE } from "#src/server/artifacts/artifact-page-annotate-runtime.server";

const frame = new Function(`${ANNOTATE_DOM_SOURCE}; return { badgeLeft };`)() as {
  badgeLeft: (left: number, viewportWidth: number) => number;
};

test("a badge stays inside the frame's width, so a narrow frame does not scroll sideways", () => {
  expect(frame.badgeLeft(500, 512)).toBe(488);
  expect(frame.badgeLeft(100, 512)).toBe(100);
  expect(frame.badgeLeft(-6, 512)).toBe(0);
});

test("a badge on content scrolled out to the side keeps its place", () => {
  expect(frame.badgeLeft(900, 512)).toBe(900);
});
