import type { AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";
import type { KiroUsageReader } from "./usage";

/** Connection identity and process ownership are supplied by the embedding host. */
export interface KiroConnectionHost {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
}

/** Native credentials and request details never cross the usage-response port. */
export interface KiroRuntimeHost extends KiroConnectionHost {
  readonly versionReader: CliVersionReader;
  readonly readUsageResponse: KiroUsageReader;
  buildEnvironment(options: AgentSessionOptions): Record<string, string>;
  buildCatalogEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): Record<string, string>;
}

export interface KiroProviderOptions {
  readonly host: KiroRuntimeHost;
  readonly command?: readonly string[];
  readonly configTimeoutMs?: number;
}
