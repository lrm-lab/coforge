import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { CodexHistoryHost } from "@lrm/coforge-anvil/codex";

/** File IO for Codex rollout reads. `node:fs/promises` `readdir` supplies the directory types. */
export const codexHistoryHost: CodexHistoryHost = {
  readHostEnvironment: (name) => Bun.env[name],
  homeDirectory: homedir,
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  async readFileTail(path, tailBytes) {
    const file = Bun.file(path);
    const { size } = await file.stat();
    const start = Math.max(0, size - tailBytes);
    return { text: await file.slice(start, size).text(), startOffset: start };
  },
};
