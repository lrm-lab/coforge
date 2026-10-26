import { expect, test } from "bun:test";
import { readStoredImageDimensionsResult } from "#src/server/attachments/attachment-image-dimensions.server";

const input = { objectKey: "test-only-key", contentType: "image/png", sizeBytes: 24 };
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000c00000006", "hex");

test("maintenance distinguishes known dimensions, unknown headers and safe failure categories", async () => {
  expect(await readStoredImageDimensionsResult({ readPrefix: async () => png }, input)).toEqual({
    status: "known",
    dimensions: { imageWidth: 12, imageHeight: 6 },
  });
  expect(
    await readStoredImageDimensionsResult({ readPrefix: async () => new Uint8Array([1]) }, input),
  ).toEqual({ status: "unknown", reason: "unknown_header" });
  expect(await readStoredImageDimensionsResult({ readPrefix: async () => null }, input)).toEqual({
    status: "failed",
    reason: "object_missing",
  });
  expect(
    await readStoredImageDimensionsResult(
      {
        readPrefix: async () => {
          throw new Error("private upstream content must not appear");
        },
      },
      input,
    ),
  ).toEqual({ status: "failed", reason: "storage_error" });
});

test("maintenance reports timeout after canceling its only prefix read", async () => {
  let aborted = false;
  const result = await readStoredImageDimensionsResult(
    {
      readPrefix: async (_key, { signal }) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    },
    input,
    { timeoutMs: 5 },
  );
  expect(result).toEqual({ status: "failed", reason: "timeout" });
  expect(aborted).toBe(true);
});
