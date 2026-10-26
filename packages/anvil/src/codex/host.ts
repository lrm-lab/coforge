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

/** Native session and usage policies consume distinct host environment compositions. */
export interface CodexRuntimeHost extends CodexConnectionHost, CodexUsageHost {
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
