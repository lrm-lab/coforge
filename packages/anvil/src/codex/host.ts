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

/**
 * Rollout reads stay in the Codex driver. The host performs the file IO and supplies
 * `CODEX_HOME` / `HOME` without the driver reading the process environment itself.
 */
export interface CodexHistoryHost {
  readHostEnvironment(name: "CODEX_HOME" | "HOME" | "USERPROFILE"): string | undefined;
  homeDirectory(): string;
  readDirectoryEntries(path: string): Promise<readonly CodexDirectoryEntry[]>;
  readFileTail(path: string, tailBytes: number): Promise<{ text: string; startOffset: number }>;
}

/** Native session and usage policies consume distinct host environment compositions. */
export interface CodexRuntimeHost extends CodexConnectionHost, CodexUsageHost, CodexHistoryHost {
  buildSessionEnvironment(options: AgentSessionOptions): Record<string, string>;
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
