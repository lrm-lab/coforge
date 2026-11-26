import type { AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { JsonlCatalogHost } from "#src/catalog-process";
import type { CodexCliRunner } from "./auth";

export type CodexClientInfo = Readonly<{ name: string; title: string; version: string }>;

export interface CodexConnectionHost {
  readonly clientInfo: CodexClientInfo;
  readonly processTreeSpawner: ProcessTreeSpawner;
}

export interface CodexUsageHost {
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly usageClientInfo: CodexClientInfo;
  buildUsageEnvironment(environment?: Readonly<Record<string, string>>): Record<string, string>;
  maskAccountLabel(value: string): string | undefined;
}

export interface CodexDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface CodexFileInfo {
  readonly mtimeMs: number;
  readonly size: number;
  isFile(): boolean;
}

export interface CodexHistoryHost {
  readHostEnvironment(name: "CODEX_HOME" | "HOME" | "USERPROFILE"): string | undefined;
  homeDirectory(): string;
  readDirectoryEntries(path: string): Promise<readonly CodexDirectoryEntry[]>;
  resolveDirectoryWithoutSymlinks(path: string): Promise<string | null>;
  lstat?(path: string): Promise<CodexFileInfo>;
  readFileTail(path: string, tailBytes: number): Promise<{ text: string; startOffset: number }>;
  readFileHeadBytes(root: string, path: string, headBytes: number): Promise<{ bytes: Uint8Array }>;
  readFileTailBytes(
    root: string,
    path: string,
    tailBytes: number,
  ): Promise<{ bytes: Uint8Array; startOffset: number }>;
  realWorkspaceRoot?(path: string): Promise<string | null>;
  rereadFile?(path: string, realRoot: string | null): Promise<string | null>;
}

/** Native session and usage policies consume distinct host environment compositions. */
export interface CodexRuntimeHost extends CodexConnectionHost, CodexUsageHost, CodexHistoryHost {
  buildSessionEnvironment(options: AgentSessionOptions): Record<string, string>;
  /** A Codex settings file's text. A rejection means the file is absent or unreadable. */
  readFileText(path: string): Promise<string>;
}

/** Native cache layout is Codex policy; actual file reads belong to the host. */
export interface CodexCatalogHost extends CodexConnectionHost, JsonlCatalogHost {
  readJsonFile(path: string): Promise<unknown>;
}

/** CLI execution and effective environment stay with the embedding host. */
export interface CodexAuthHost extends CodexConnectionHost {
  buildAuthEnvironment(): Record<string, string>;
  readonly runCli: CodexCliRunner;
  maskAccountLabel(value: string): string | undefined;
}
