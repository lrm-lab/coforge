import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  digestsMatch,
  digestOf,
  objectDigest,
  objectDigestIfPresent,
  putObject,
  type ObjectDigest,
} from "./oss-objects";
import type { UploadContext } from "./publish";

function mismatch(
  objectKey: string,
  local: ObjectDigest,
  stored: ObjectDigest,
  state: string,
): Error {
  return new Error(
    `OSS object mismatch: ${objectKey} ${state} crc64=${stored.crc64} size=${stored.size}, ` +
      `the local bytes are crc64=${local.crc64} size=${local.size}`,
  );
}

export async function uploadObjects(
  context: UploadContext,
  uploads: readonly string[],
  allowExisting: boolean,
): Promise<Map<string, ObjectDigest>> {
  const digests = new Map<string, ObjectDigest>();
  for (const relativePath of uploads) {
    const bytes = await readFile(join(context.outputDirectory, relativePath));
    const present = allowExisting
      ? await objectDigestIfPresent(context.client, relativePath)
      : undefined;
    if (present) {
      const digest = digestOf(bytes);
      digests.set(relativePath, digest);
      if (!digestsMatch(digest, present)) throw mismatch(relativePath, digest, present, "is up as");
      context.log(
        `already present, verified ${relativePath} crc64=${digest.crc64} size=${digest.size}`,
      );
      continue;
    }
    const upload = putObject(context.client, relativePath, bytes, {
      requestTimeoutMs: context.requestTimeoutMs,
    });
    const digest = digestOf(bytes);
    digests.set(relativePath, digest);
    const reported = await upload;
    if (reported !== digest.crc64) {
      throw new Error(
        `OSS stored ${relativePath} as crc64=${reported}, the uploaded bytes are crc64=${digest.crc64}`,
      );
    }
    context.log(`uploaded ${relativePath} crc64=${digest.crc64} size=${digest.size}`);
  }
  return digests;
}

export async function verifyUploadedObjects(
  context: UploadContext,
  files: readonly string[],
  digests: ReadonlyMap<string, ObjectDigest>,
): Promise<void> {
  for (const relativePath of files) {
    const digest = digests.get(relativePath);
    if (!digest) throw new Error(`no local digest was recorded for ${relativePath}`);
    const stored = await objectDigest(context.client, relativePath);
    if (!digestsMatch(digest, stored)) throw mismatch(relativePath, digest, stored, "has");
    context.log(`verified ${relativePath} crc64=${digest.crc64} size=${digest.size}`);
  }
}
