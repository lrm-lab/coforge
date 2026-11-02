import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parse, resolve } from "node:path";

async function readAt(path: string, start: (size: number) => number, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("History path is not a regular file");
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
  const read = await readHistoryFileTailBytes(path, maxBytes);
  return { text: new TextDecoder().decode(read.bytes), startOffset: read.startOffset };
}

export function readHistoryFileHeadBytes(path: string, maxBytes: number) {
  return readAt(path, () => 0, maxBytes);
}

export function readHistoryFileTailBytes(path: string, maxBytes: number) {
  return readAt(path, (size) => Math.max(0, size - maxBytes), maxBytes);
}

/** True only when every component through `path` is a real directory, never a symlink. */
export async function isDirectoryWithoutSymlinks(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = root;
  try {
    for (const part of parts) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    return parts.length > 0;
  } catch {
    return false;
  }
}
