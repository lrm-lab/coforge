import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { CodexHistoryHost } from "@lrm/coforge-anvil/codex";
import {
  readHistoryFileHeadBytes,
  readHistoryFileTail,
  readHistoryFileTailBytes,
  resolveDirectoryWithoutSymlinks,
} from "#src/code-agent/bounded-history-file";
import {
  rereadWorkspaceFile,
  resolveRealWorkspaceRoot,
} from "#src/code-agent/workspace-file-reread";

export const codexHistoryHost: CodexHistoryHost = {
  readHostEnvironment: (name) => Bun.env[name],
  homeDirectory: homedir,
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  resolveDirectoryWithoutSymlinks,
  lstat,
  readFileTail: readHistoryFileTail,
  readFileHeadBytes: readHistoryFileHeadBytes,
  readFileTailBytes: readHistoryFileTailBytes,
  realWorkspaceRoot: resolveRealWorkspaceRoot,
  rereadFile: rereadWorkspaceFile,
};
