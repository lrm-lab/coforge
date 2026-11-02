import { constants } from "node:fs";
import { open } from "node:fs/promises";

async function readAt(path: string, start: (size: number) => number, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("History path is not a regular file");
    const offset = start(info.size);
    const length = Math.max(0, Math.min(maxBytes, info.size - offset));
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), startOffset: offset };
  } finally {
    await handle.close();
  }
}

export async function readHistoryFileHead(path: string, maxBytes: number): Promise<string> {
  return (await readAt(path, () => 0, maxBytes)).text;
}

export function readHistoryFileTail(path: string, maxBytes: number) {
  return readAt(path, (size) => Math.max(0, size - maxBytes), maxBytes);
}
