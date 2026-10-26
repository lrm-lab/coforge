import { imageSize } from "image-size";
import { isInlineImage } from "./attachment-response.server";
import type { FileStorage } from "#src/server/files/file-storage.server";

export const IMAGE_HEADER_MAX_BYTES = 256 * 1024;
export const IMAGE_HEADER_TIMEOUT_MS = 1000;

export type ImageDimensions = { imageWidth: number; imageHeight: number };

/** Metadata only: never decode pixels or turn an unrecognized upload into an image. */
export function imageDimensions(bytes: Uint8Array, contentType: string): ImageDimensions | null {
  if (!isInlineImage(contentType) || bytes.length > IMAGE_HEADER_MAX_BYTES) return null;
  try {
    // Some library readers use the backing ArrayBuffer rather than the view's bounds.
    // Give them an exact-length buffer so a short prefix cannot read bytes outside it.
    const input = Uint8Array.from(bytes);
    const signature = Buffer.from(input.subarray(0, 16)).toString("hex");
    const matches =
      contentType === "image/jpeg"
        ? signature.startsWith("ffd8ff")
        : contentType === "image/png"
          ? signature.startsWith("89504e470d0a1a0a")
          : contentType === "image/gif"
            ? signature.startsWith("474946383761") || signature.startsWith("474946383961")
            : signature.startsWith("52494646") && signature.slice(16, 24) === "57454250";
    if (!matches || (contentType === "image/jpeg" && !supportedJpegHeader(input))) return null;
    const size = imageSize(input);
    const mime = size.type === "jpg" ? "image/jpeg" : `image/${size.type}`;
    if (mime !== contentType) return null;
    let { width, height } = size;
    if (size.orientation && size.orientation >= 5 && size.orientation <= 8)
      [width, height] = [height, width];
    if (
      ![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 2147483647)
    )
      return null;
    return { imageWidth: width, imageHeight: height };
  } catch {
    return null;
  }
}

/** image-size 2.0.2 reads only the conventional TIFF IFD0 offset (8). Reject layouts it
 * cannot orient reliably, incomplete segments and pathological segment counts; this is
 * validation, not an alternate image decoder. SOF dimensions still come from the library. */
function supportedJpegHeader(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let exifSeen = false;
  for (let segments = 0; segments < 256 && offset + 4 <= bytes.length; segments++) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return length >= 8;
    if (marker === 0xda || marker === 0xd9) return false;
    if (
      marker === 0xe1 &&
      Buffer.from(bytes.subarray(offset + 4, offset + 10)).toString() === "Exif\0\0"
    ) {
      if (exifSeen) return false;
      exifSeen = true;
      const tiff = new DataView(bytes.buffer, bytes.byteOffset + offset + 10, length - 8);
      const order = tiff.getUint16(0);
      const littleEndian = order === 0x4949;
      if (
        (!littleEndian && order !== 0x4d4d) ||
        tiff.getUint16(2, littleEndian) !== 42 ||
        tiff.getUint32(4, littleEndian) !== 8
      )
        return false;
      const count = tiff.getUint16(8, littleEndian);
      if (10 + count * 12 + 4 > tiff.byteLength) return false;
      for (let i = 0; i < count; i++) {
        const entry = 10 + i * 12;
        if (tiff.getUint16(entry, littleEndian) !== 0x112) continue;
        const orientation = tiff.getUint16(entry + 8, littleEndian);
        if (
          tiff.getUint16(entry + 2, littleEndian) !== 3 ||
          tiff.getUint32(entry + 4, littleEndian) !== 1 ||
          orientation < 1 ||
          orientation > 8
        )
          return false;
      }
    }
    offset += length + 2;
  }
  return false;
}

export async function readFileImageDimensions(file: Blob, contentType: string) {
  if (!isInlineImage(contentType)) return null;
  try {
    return imageDimensions(
      new Uint8Array(await file.slice(0, IMAGE_HEADER_MAX_BYTES).arrayBuffer()),
      contentType,
    );
  } catch {
    return null;
  }
}

/** Optional metadata stays outside the attachment transaction and never makes upload fail. */
export async function readStoredImageDimensions(
  storage: Pick<FileStorage, "readPrefix">,
  input: { objectKey: string; contentType: string; sizeBytes: number },
  options: { timeoutMs?: number } = {},
): Promise<ImageDimensions | null> {
  if (!isInlineImage(input.contentType) || !storage.readPrefix || input.sizeBytes <= 0) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, options.timeoutMs ?? IMAGE_HEADER_TIMEOUT_MS);
    });
    const bytes = await Promise.race([
      storage.readPrefix(input.objectKey, {
        maxBytes: Math.min(input.sizeBytes, IMAGE_HEADER_MAX_BYTES),
        signal: controller.signal,
      }),
      expired,
    ]);
    return bytes ? imageDimensions(bytes, input.contentType) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
