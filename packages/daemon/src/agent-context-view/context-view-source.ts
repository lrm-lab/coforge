import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { totalmem } from "node:os";
import { isAbsolute, relative } from "node:path";
import { isPrivateRegularFile } from "#src/agent-runtime/private-file";

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
export type ContextViewOpenedSourceResult =
  | { ok: true; handle: FileHandle; size: number }
  | { ok: false; failure: ContextViewSourceFailure };

export type ContextViewSourceFingerprint = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

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

export function fingerprintContextViewSource(
  sourcePath: string,
  allowedRoots: readonly string[],
  maxBytes = contextViewSourceMaxBytes(),
): ContextViewSourceFingerprint | undefined {
  if (!sourcePath || !allowedRoots.length) return undefined;
  try {
    const realRoots: string[] = [];
    for (const root of allowedRoots) {
      try {
        realRoots.push(realpathSync(root));
      } catch {
        return undefined;
      }
    }
    const realSource = realpathSync(sourcePath);
    if (!realRoots.some((root) => contained(realSource, root))) return undefined;
    const listed = lstatSync(sourcePath);
    if (!isPrivateRegularFile(listed) || listed.size > maxBytes) return undefined;
    const fd = openSync(sourcePath, CONTEXT_VIEW_SOURCE_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (
        !isPrivateRegularFile(info) ||
        info.dev !== listed.dev ||
        info.ino !== listed.ino ||
        info.size > maxBytes
      )
        return undefined;
      return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
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
    if (!isPrivateRegularFile(listed)) return { ok: false, failure: "unsafe" };
    const fd = openSync(sourcePath, CONTEXT_VIEW_SOURCE_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (!isPrivateRegularFile(info) || info.dev !== listed.dev || info.ino !== listed.ino)
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

export async function openContextViewSourceAsync(
  sourcePath: string,
  allowedRoots: readonly string[],
  maxBytes = contextViewSourceMaxBytes(),
): Promise<ContextViewOpenedSourceResult> {
  if (!sourcePath || !allowedRoots.length) return { ok: false, failure: "outside_root" };
  try {
    const realRoots: string[] = [];
    for (const root of allowedRoots) {
      try {
        realRoots.push(await realpath(root));
      } catch {
        return { ok: false, failure: "outside_root" };
      }
    }
    const realSource = await realpath(sourcePath);
    if (!realRoots.some((root) => contained(realSource, root)))
      return { ok: false, failure: "outside_root" };
    const listed = await lstat(sourcePath);
    if (!isPrivateRegularFile(listed)) return { ok: false, failure: "unsafe" };
    const handle = await open(sourcePath, CONTEXT_VIEW_SOURCE_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!isPrivateRegularFile(info) || info.dev !== listed.dev || info.ino !== listed.ino) {
        await handle.close();
        return { ok: false, failure: "unsafe" };
      }
      if (info.size > maxBytes) {
        await handle.close();
        return { ok: false, failure: "too_large" };
      }
      return { ok: true, handle, size: info.size };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return { ok: false, failure: code === "ENOENT" ? "missing" : "read_failed" };
  }
}

export async function readContextViewSourceAsync(
  sourcePath: string,
  allowedRoots: readonly string[],
  maxBytes = contextViewSourceMaxBytes(),
): Promise<ContextViewSourceResult> {
  const opened = await openContextViewSourceAsync(sourcePath, allowedRoots, maxBytes);
  if (!opened.ok) return opened;
  try {
    const buffer = await opened.handle.readFile();
    if (buffer.byteLength > maxBytes) return { ok: false, failure: "too_large" };
    return { ok: true, buffer, sourceBytes: buffer.byteLength };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return { ok: false, failure: code === "ENOENT" ? "missing" : "read_failed" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
