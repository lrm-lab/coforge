import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";

async function readAt(
  path: string,
  start: (size: number) => number,
  maxBytes: number,
  containmentRoot?: string,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("History path is not a regular file");
    if (containmentRoot) {
      const actual = await realpath(path);
      const actualInfo = await lstat(actual);
      if (
        !actual.startsWith(containmentRoot + sep) ||
        actualInfo.dev !== info.dev ||
        actualInfo.ino !== info.ino
      )
        throw new Error("History path escaped its provider root");
    }
    const offset = start(info.size);
    const length = Math.max(0, Math.min(maxBytes, info.size - offset));
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { bytes: buffer.subarray(0, bytesRead), startOffset: offset };
  } finally {
    await handle.close();
  }
}

export async function readHistoryFileTail(path: string, maxBytes: number) {
  const read = await readAt(path, (size) => Math.max(0, size - maxBytes), maxBytes);
  return { text: new TextDecoder().decode(read.bytes), startOffset: read.startOffset };
}

export function readHistoryFileHeadBytes(root: string, path: string, maxBytes: number) {
  return readAt(path, () => 0, maxBytes, root);
}

export function readHistoryFileTailBytes(root: string, path: string, maxBytes: number) {
  return readAt(path, (size) => Math.max(0, size - maxBytes), maxBytes, root);
}

/**
 * The stable real identity of `path` only when every component is a directory, never a symlink.
 * The final lstat identity must still match its real path, closing a swap between the walk and
 * realpath. Contained file reads keep this identity and compare their opened file afterward.
 */
export async function resolveDirectoryWithoutSymlinks(path: string): Promise<string | undefined> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = root;
  try {
    let final;
    for (const part of parts) {
      current = resolve(current, part);
      final = await lstat(current);
      if (!final.isDirectory() || final.isSymbolicLink()) return;
    }
    if (!final || parts.length === 0) return;
    const actual = await realpath(absolute);
    const actualInfo = await lstat(actual);
    if (actualInfo.dev !== final.dev || actualInfo.ino !== final.ino) return;
    return actual;
  } catch {
    return;
  }
}
