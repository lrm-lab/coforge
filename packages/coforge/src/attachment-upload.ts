import { stat } from "node:fs/promises";
import { MIME_TYPE_PATTERN } from "@lrm/coforge-sdk/internal";
import { CliError } from "./cli-error";

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

const MAGIC_BYTES: readonly (readonly [string, readonly number[]])[] = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
];

/** Enough leading bytes to tell the supported image formats apart. */
const SNIFF_PREFIX_BYTES = 16;

const startsWith = (prefix: Uint8Array, signature: readonly number[], offset = 0) =>
  prefix.length >= offset + signature.length &&
  signature.every((byte, index) => prefix[offset + index] === byte);

/** The image type a file's leading bytes declare (PNG, JPEG, GIF or WebP), whatever its name says. */
export function sniffImageMimeType(prefix: Uint8Array): string | undefined {
  for (const [mimeType, signature] of MAGIC_BYTES)
    if (startsWith(prefix, signature)) return mimeType;
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  return startsWith(prefix, riff) && startsWith(prefix, webp, 8) ? "image/webp" : undefined;
}

/**
 * Explicit `--mime-type` wins, then the file's leading bytes (a `.png` that holds a JPEG is a
 * JPEG), then its extension, then a safe default.
 */
export function attachmentMimeType(
  path: string,
  explicitMimeType?: string,
  prefix?: Uint8Array,
): string {
  if (explicitMimeType) return explicitMimeType;
  const sniffed = prefix && sniffImageMimeType(prefix);
  if (sniffed) return sniffed;
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return EXTENSION_MIME_TYPES[extension] ?? "application/octet-stream";
}

function invalidArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

/** The error for a missing upload target: code `MISSING_CHANNEL`, naming the accepted forms. */
function missingTarget(): CliError {
  return new CliError({
    code: "MISSING_CHANNEL",
    message:
      "A target is required to attach the upload to. Pass --target '#name', '@user', or a thread target.",
    retryable: false,
  });
}

/** Validates `--mime-type`; a local precondition `CliError`, never a request. */
export function validateAttachmentMimeType(mimeType: string): void {
  if (!MIME_TYPE_PATTERN.test(mimeType))
    throw invalidArg(`--mime-type must look like type/subtype, got: ${mimeType}`);
}

/**
 * The `coforge attachment upload` preconditions that never issue a request, in this exact order:
 * `--path` presence, existence, regular-file, non-empty, then `--target` presence
 * (`MISSING_CHANNEL`), then `--mime-type` well-formedness. Returns the file's size for the
 * caller's subsequent server-capability size check (`GET .../attachments/capabilities`), which
 * does issue a request.
 */
export async function validateAttachmentUploadArgs(input: {
  path?: string;
  target?: string;
  mimeType?: string;
}): Promise<{ path: string; target: string; sizeBytes: number }> {
  if (!input.path) throw invalidArg("--path is required");
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(input.path);
  } catch {
    throw invalidArg(`--path does not exist: ${input.path}`);
  }
  if (!stats.isFile()) throw invalidArg(`--path is not a regular file: ${input.path}`);
  if (stats.size === 0) throw invalidArg("--path is empty; refusing to upload a 0-byte attachment");
  if (!input.target) throw missingTarget();
  if (input.mimeType !== undefined) validateAttachmentMimeType(input.mimeType);
  return { path: input.path, target: input.target, sizeBytes: stats.size };
}

/** The MIME type to upload `path` as: `attachmentMimeType` with the file's leading bytes read. */
export async function inferAttachmentMimeType(
  path: string,
  explicitMimeType?: string,
): Promise<string> {
  if (explicitMimeType) return explicitMimeType;
  const prefix = new Uint8Array(await Bun.file(path).slice(0, SNIFF_PREFIX_BYTES).arrayBuffer());
  return attachmentMimeType(path, undefined, prefix);
}
