import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { CodexHistoryHost } from "@lrm/coforge-anvil/codex";
import { readHistoryFileHead, readHistoryFileTail } from "#src/code-agent/bounded-history-file";

/** File IO for Codex rollout reads. `node:fs/promises` `readdir` supplies the directory types. */
export const codexHistoryHost: CodexHistoryHost = {
  readHostEnvironment: (name) => Bun.env[name],
  homeDirectory: homedir,
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readFileHead: readHistoryFileHead,
  readFileTail: readHistoryFileTail,
};
