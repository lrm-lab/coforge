import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { MEMORY_FILE_RE, SENSITIVE_PATH_RE } from "@lrm/coforge-anvil/claude-code";

export const REREAD_WORKSPACE_FILE_MAX_BYTES = 64 * 1024;

export function resolveRealWorkspaceRoot(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/**
 * Re-reads a small UTF-8 workspace file live from disk, returning `null` if:
 * - `realRoot` is unavailable,
 * - any segment inside the workspace is a symbolic link (`lstat` + `O_NOFOLLOW`),
 * - the resolved path escapes `realRoot`,
 * - the path matches `SENSITIVE_PATH_RE` or `MEMORY_FILE_RE`,
 * - the file exceeds 64 KiB or contains NUL bytes.
 */
export async function rereadWorkspaceFile(
  candidatePath: string,
  realRoot: string | null,
): Promise<string | null> {
  if (realRoot === null) return null;
  try {
    const candidateStat = await lstat(candidatePath);
    if (
      candidateStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      candidateStat.size > REREAD_WORKSPACE_FILE_MAX_BYTES
    ) {
      return null;
    }
    const real = await realpath(candidatePath);
    if (
      !real.startsWith(realRoot + sep) ||
      SENSITIVE_PATH_RE.test(candidatePath) ||
      SENSITIVE_PATH_RE.test(real) ||
      MEMORY_FILE_RE.test(candidatePath) ||
      MEMORY_FILE_RE.test(real)
    ) {
      return null;
    }
    // Reject intermediate directory symlinks inside realRoot as well.
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith("..")) return null;
    let cursor = realRoot;
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      const step = await lstat(cursor);
      if (step.isSymbolicLink()) return null;
    }
    const handle = await open(
      real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > REREAD_WORKSPACE_FILE_MAX_BYTES) return null;
      const text = await handle.readFile({ encoding: "utf8" });
      return text.includes("\0") ? null : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
