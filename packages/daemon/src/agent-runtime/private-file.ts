import type { Stats } from "node:fs";

/** A regular file with exactly one directory entry, so its bytes are private to this path. */
export function isPrivateRegularFile(info: Pick<Stats, "isFile" | "nlink">): boolean {
  return info.isFile() && info.nlink === 1;
}
