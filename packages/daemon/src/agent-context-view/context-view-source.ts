import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { totalmem } from "node:os";
import { isAbsolute, relative } from "node:path";

export const CONTEXT_VIEW_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
export const CONTEXT_VIEW_SOURCE_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type ContextViewSourceFailure =
  | "missing"
  | "outside_root"
  | "unsafe"
  | "too_large"
  | "read_failed";
export type ContextViewSourceResult =
  | { ok: true; buffer: Buffer; sourceBytes: number }
  | { ok: false; failure: ContextViewSourceFailure };

function contextViewMemoryBytes(): number {
  const constrained =
    typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
  return constrained > 0 ? Math.min(constrained, totalmem()) : totalmem();
}

export function contextViewSourceMaxBytes(): number {
  return Math.min(CONTEXT_VIEW_SOURCE_MAX_BYTES, Math.floor(contextViewMemoryBytes() / 4));
}

function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function readContextViewSource(
  sourcePath: string,
  allowedRoots: readonly string[],
  maxBytes = contextViewSourceMaxBytes(),
): ContextViewSourceResult {
  if (!sourcePath || !allowedRoots.length) return { ok: false, failure: "outside_root" };
  try {
    const realRoots: string[] = [];
    for (const root of allowedRoots) {
      try {
        realRoots.push(realpathSync(root));
      } catch {
        return { ok: false, failure: "outside_root" };
      }
    }
    const realSource = realpathSync(sourcePath);
    const inRoot = realRoots.some((root) => contained(realSource, root));
    if (!inRoot) return { ok: false, failure: "outside_root" };
    const listed = lstatSync(sourcePath);
    if (!listed.isFile() || listed.nlink > 1) return { ok: false, failure: "unsafe" };
    const fd = openSync(sourcePath, CONTEXT_VIEW_SOURCE_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || info.dev !== listed.dev || info.ino !== listed.ino)
        return { ok: false, failure: "unsafe" };
      if (info.size > maxBytes) return { ok: false, failure: "too_large" };
      const buffer = readFileSync(fd);
      if (buffer.byteLength > maxBytes) return { ok: false, failure: "too_large" };
      return { ok: true, buffer, sourceBytes: buffer.byteLength };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return { ok: false, failure: code === "ENOENT" ? "missing" : "read_failed" };
  }
}
