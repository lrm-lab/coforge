import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ARTIFACT_COMMENT_IMAGES_MAX,
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  ARTIFACT_REVIEW_IMAGES_MAX,
} from "@lrm/coforge-sdk/agent";
import { sha256Hex } from "#src/artifact-directory";
import type { ArtifactDirectoryTransport } from "#src/artifact-directory-args";
import { invalidArg } from "#src/cli-error";
import { requireCall } from "#src/artifact-transfer";

const starts = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, index) => bytes[at + index] === byte);

export function isImage(bytes: Uint8Array): boolean {
  return (
    starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    starts(bytes, [0xff, 0xd8, 0xff]) ||
    starts(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8))
  );
}

export function requireImageCount(count: number, max: number, what: string) {
  if (count > max) throw invalidArg(`${what} takes at most ${max} images, not ${count}`);
}

export const REVIEW_IMAGES_MAX = ARTIFACT_REVIEW_IMAGES_MAX;
export const COMMENT_IMAGES_MAX = ARTIFACT_COMMENT_IMAGES_MAX;

export async function uploadImage(
  transport: ArtifactDirectoryTransport,
  path: string,
  cwd = process.cwd(),
): Promise<string> {
  const file = resolve(cwd, path);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw invalidArg(`${path} is not a file`);
  if (info.size === 0) throw invalidArg(`${path} is empty`);
  if (info.size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES)
    throw invalidArg(`${path} is over 10 MiB: an image may be at most 10 MiB`);
  const bytes = new Uint8Array(await readFile(file)) as Uint8Array<ArrayBuffer>;
  if (!isImage(bytes)) throw invalidArg(`${path} is not a PNG, JPEG, GIF or WebP image`);
  const sha256 = sha256Hex(bytes);
  await requireCall(transport.artifactUpload, "upload")(sha256, bytes);
  return sha256;
}
