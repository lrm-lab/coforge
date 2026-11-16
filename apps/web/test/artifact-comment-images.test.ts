import { expect, test } from "bun:test";
import sharp from "sharp";
import {
  prepareImages,
  type CommentImageBlobs,
} from "#src/server/artifacts/artifact-comment-images.server";

const principal = { workspaceId: crypto.randomUUID(), agentId: crypto.randomUUID() };

const blobsHolding = (bytes: Uint8Array): CommentImageBlobs =>
  ({
    allowed: async (_workspace: unknown, _artifact: unknown, _actor: unknown, shas: string[]) =>
      new Set(shas),
    read: async () => bytes,
    upload: async () => ({ sha256: "f".repeat(64) }),
    use: async () => [],
  }) as unknown as CommentImageBlobs;

const prepare = (bytes: Uint8Array) =>
  prepareImages(blobsHolding(bytes), principal, ["a".repeat(64)]);

test("an animated image counts every frame against the pixel limit", async () => {
  const frames = await Promise.all(
    Array.from({ length: 11 }, (_, shade) =>
      sharp({
        create: {
          width: 4000,
          height: 1000,
          channels: 3,
          background: { r: shade * 20, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  const gif = await sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
  await expect(prepare(gif)).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-image-pixels",
  });
});

test("a small image is re-encoded and measured", async () => {
  const png = await sharp({
    create: { width: 30, height: 20, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  expect(await prepare(png)).toMatchObject([{ contentType: "image/png", width: 30, height: 20 }]);
});
