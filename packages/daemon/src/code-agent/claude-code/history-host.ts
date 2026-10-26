import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import {
  SENSITIVE_PATH_RE,
  MEMORY_FILE_RE,
  type ClaudeBriefingHost,
} from "@lrm/coforge-anvil/claude-code";

const REREAD_FILE_MAX_BYTES = 64 * 1024;

/**
 * A file's current text, or `null`: only a regular, small, text file whose real location (every
 * symlink resolved) is inside `root` and not sensitive. The final component is opened with
 * `O_NOFOLLOW`, so a link swapped in after the check is refused too.
 */
async function rereadFile(path: string, realRoot: string | null): Promise<string | null> {
  if (realRoot === null) return null;
  try {
    const real = await realpath(path);
    if (
      !real.startsWith(realRoot + sep) ||
      SENSITIVE_PATH_RE.test(real) ||
      MEMORY_FILE_RE.test(real)
    )
      return null;
    const info = await lstat(real);
    if (!info.isFile() || info.size > REREAD_FILE_MAX_BYTES) return null;
    const handle = await open(
      real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > REREAD_FILE_MAX_BYTES) return null;
      const text = await handle.readFile({ encoding: "utf8" });
      return text.includes("\0") ? null : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export const claudeHistoryHost: ClaudeBriefingHost = {
  readHostEnvironment: (name) => Bun.env[name],
  homeDirectory: homedir,
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readDirectoryNames: (path) => readdir(path),
  lstat,
  async readFileTail(path, tailBytes) {
    const file = Bun.file(path);
    const { size } = await file.stat();
    const start = Math.max(0, size - tailBytes);
    return { text: await file.slice(start, size).text(), startOffset: start };
  },
  realWorkspaceRoot: (path) => realpath(path).catch(() => null),
  rereadFile,
};
