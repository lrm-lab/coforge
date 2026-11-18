import { afterAll, beforeAll, expect, test } from "bun:test";
import { artifactThumbnail } from "#src/server/artifacts/artifact-thumbnail.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { grayPng as png } from "./helpers/test-bitmap";

let f: CommentsFixture;
beforeAll(async () => {
  f = await commentsFixture("thumb");
});
afterAll(() => f.cleanup());

function claimingSize(source: Uint8Array, width: number, height: number): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, Bun.hash.crc32(bytes.subarray(12, 29)));
  return bytes;
}

const thumbnail = (artifactId: string, userId: string, path: string, version = 1) =>
  artifactThumbnail(
    { reads: f.artifacts.reads, blobs: f.blobs },
    { workspaceId: f.workspaceId, artifactId, userId, path, version },
  );

test("a large image entry comes back as a WebP no wider or taller than 640 px, cached for good", async () => {
  const artifact = await f.make(
    "Wide",
    { "photo.png": await png(2000, 1000) },
    { entry: "photo.png" },
  );
  const response = await thumbnail(artifact, f.bob, "photo.png");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/webp");
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const shown = await new Bun.Image(await response.bytes()).metadata();
  expect(shown).toEqual({ width: 640, height: 320, format: "webp" });
});

test("a small image entry is never enlarged", async () => {
  const artifact = await f.make("Small", { "dot.png": await png(100, 50) }, { entry: "dot.png" });
  const shown = await new Bun.Image(
    await (await thumbnail(artifact, f.bob, "dot.png")).bytes(),
  ).metadata();
  expect(shown).toEqual({ width: 100, height: 50, format: "webp" });
});

test("no thumbnail for a broken image, one claiming too many pixels, an SVG, a text file or a missing path", async () => {
  const broken = await f.make("Broken", { "pic.png": "not really a png" }, { entry: "pic.png" });
  const huge = await f.make(
    "Huge",
    { "huge.png": claimingSize(await png(4, 4), 30_000, 30_000) },
    { entry: "huge.png" },
  );
  const vector = await f.make(
    "Vector",
    { "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="6"/>` },
    { entry: "logo.svg" },
  );
  const notes = await f.make("Notes");
  for (const [artifact, path] of [
    [broken, "pic.png"],
    [huge, "huge.png"],
    [vector, "logo.svg"],
    [notes, "plan.md"],
    [notes, "missing.png"],
  ] as const)
    await expect(thumbnail(artifact, f.bob, path)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("no thumbnail of an artifact the person cannot read, or of a version it does not have", async () => {
  const hidden = await f.make(
    "Hidden photo",
    { "photo.png": await png(20, 20) },
    { entry: "photo.png", target: `#${f.privateChannel}` },
  );
  await expect(thumbnail(hidden, f.bob, "photo.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
  const shown = await f.make(
    "Shown photo",
    { "photo.png": await png(20, 20) },
    { entry: "photo.png" },
  );
  await expect(thumbnail(shown, f.bob, "photo.png", 2)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
