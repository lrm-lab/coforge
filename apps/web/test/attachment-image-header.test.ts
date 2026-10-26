import { expect, test } from "bun:test";
import {
  IMAGE_HEADER_MAX_BYTES,
  imageDimensions,
  readFileImageDimensions,
  readStoredImageDimensions,
  IMAGE_HEADER_TIMEOUT_MS,
} from "#src/server/attachments/attachment-image-dimensions.server";

// Unmodified first 32 KiB of a real Apple iPhone 4 photograph, including its 15,812-byte
// embedded JPEG thumbnail (IFD1 offsets 2006/15812); SOF is at byte 20622.
// Source: exif-samples contributors, CC BY-SA 4.0; adaptation: header-only truncation.
// https://github.com/ianare/exif-samples/blob/master/jpg/hdr/iphone_hdr_NO.jpg
// https://creativecommons.org/licenses/by-sa/4.0/
// Original SHA256 eb81d33a9b1d1bea5d133483f918c2cc927161c0dda44c9fedfa4da87c8b1cc3.
const phone = new Uint8Array(
  await Bun.file(new URL("./fixtures/iphone4-header.bin", import.meta.url)).arrayBuffer(),
);

function jpeg(orientation: number, littleEndian = false, ifdOffset = 8) {
  const tiff = Buffer.alloc(ifdOffset + 18);
  tiff.write(littleEndian ? "II" : "MM");
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.length);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, ifdOffset, littleEndian);
  view.setUint16(ifdOffset, 1, littleEndian);
  view.setUint16(ifdOffset + 2, 0x112, littleEndian);
  view.setUint16(ifdOffset + 4, 3, littleEndian);
  view.setUint32(ifdOffset + 6, 1, littleEndian);
  view.setUint16(ifdOffset + 10, orientation, littleEndian);
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    exif,
    Buffer.from([
      0xff, 0xc0, 0, 17, 8, 0, 20, 0, 30, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
    ]),
  ]);
}

test("real phone header with an embedded thumbnail reports the original, not thumbnail dimensions", () => {
  expect(imageDimensions(phone, "image/jpeg")).toEqual({ imageWidth: 3264, imageHeight: 2448 });
  const app2 = Buffer.alloc(65537);
  app2.set([0xff, 0xe2, 0xff, 0xff]);
  const padded = Buffer.concat([phone.subarray(0, 2), app2, app2, app2, phone.subarray(2)]);
  expect(padded.length).toBeLessThan(IMAGE_HEADER_MAX_BYTES);
  expect(imageDimensions(padded.subarray(0, 65536), "image/jpeg")).toBeNull();
  expect(imageDimensions(padded, "image/jpeg")).toEqual({ imageWidth: 3264, imageHeight: 2448 });
});

test("JPEG EXIF display orientation is respected in either byte order", () => {
  for (const littleEndian of [false, true])
    for (let orientation = 1; orientation <= 8; orientation++)
      expect(imageDimensions(jpeg(orientation, littleEndian), "image/jpeg")).toEqual(
        orientation < 5 ? { imageWidth: 30, imageHeight: 20 } : { imageWidth: 20, imageHeight: 30 },
      );
});

test("unsupported EXIF directory layout or invalid orientation is unknown rather than an incorrect display size", () => {
  expect(imageDimensions(jpeg(6, false, 16), "image/jpeg")).toBeNull();
  expect(imageDimensions(jpeg(9), "image/jpeg")).toBeNull();
});

test("raster formats are checked against MIME, positive PostgreSQL dimensions and available header bytes", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000c00000006", "hex");
  const gif = Buffer.from("4749463839610c000600800000000000ffffff", "hex");
  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  webp[24] = 11;
  webp[27] = 5;
  for (const [bytes, mime] of [
    [png, "image/png"],
    [gif, "image/gif"],
    [webp, "image/webp"],
  ] as const) {
    expect(imageDimensions(bytes, mime)).toEqual({ imageWidth: 12, imageHeight: 6 });
    expect(imageDimensions(bytes, "image/jpeg")).toBeNull();
    expect(imageDimensions(bytes.subarray(0, 8), mime)).toBeNull();
  }
  png.writeUInt32BE(0, 16);
  expect(imageDimensions(png, "image/png")).toBeNull();
  png.writeUInt32BE(0x80000000, 16);
  expect(imageDimensions(png, "image/png")).toBeNull();
  expect(imageDimensions(Buffer.from('<svg width="12" height="6"/>'), "image/svg+xml")).toBeNull();
  expect(imageDimensions(phone, "application/octet-stream")).toBeNull();
  expect(imageDimensions(phone.subarray(0, 1000), "image/jpeg")).toBeNull();
  expect(imageDimensions(new Uint8Array(IMAGE_HEADER_MAX_BYTES + 1), "image/png")).toBeNull();
});

test("File reads only one bounded prefix, and read failures or non-images stay nonfatal", async () => {
  expect(IMAGE_HEADER_MAX_BYTES).toBe(256 * 1024);
  const blob = new Blob([phone, new Uint8Array(IMAGE_HEADER_MAX_BYTES)]);
  let reads = 0;
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end) => {
    reads++;
    expect([start, end]).toEqual([0, IMAGE_HEADER_MAX_BYTES]);
    return slice(start, end);
  };
  blob.arrayBuffer = async () => {
    throw new Error("whole-file read forbidden");
  };
  expect(await readFileImageDimensions(blob, "image/jpeg")).toEqual({
    imageWidth: 3264,
    imageHeight: 2448,
  });
  expect(reads).toBe(1);
  expect(await readFileImageDimensions(blob, "text/plain")).toBeNull();
  expect(reads).toBe(1);
  blob.slice = () => {
    throw new Error("unreadable");
  };
  expect(await readFileImageDimensions(blob, "image/jpeg")).toBeNull();
});

test("stored image metadata has one cancellable read with a bounded deadline and no retry", async () => {
  expect(IMAGE_HEADER_TIMEOUT_MS).toBe(1000);
  let reads = 0;
  let aborted = false;
  const result = await readStoredImageDimensions(
    {
      readPrefix: async (_key, { maxBytes, signal }) => {
        reads++;
        expect(maxBytes).toBe(IMAGE_HEADER_MAX_BYTES);
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    },
    { objectKey: "key", contentType: "image/jpeg", sizeBytes: IMAGE_HEADER_MAX_BYTES + 1 },
    { timeoutMs: 5 },
  );
  expect(result).toBeNull();
  expect(aborted).toBe(true);
  expect(reads).toBe(1);
  let nonImageReads = 0;
  expect(
    await readStoredImageDimensions(
      {
        readPrefix: async () => {
          nonImageReads++;
          throw new Error("non-image must not read");
        },
      },
      { objectKey: "key", contentType: "text/plain", sizeBytes: 5 },
    ),
  ).toBeNull();
  expect(nonImageReads).toBe(0);
});
