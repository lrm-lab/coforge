import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";

export interface GrokReplyIntentScanner {
  feed(delta: {
    callId: string;
    fragment: string;
  }): Extract<AgentRuntimeEvent, { type: "reply-intent" }> | undefined;
  complete(callId: string): void;
  reset(): string[];
}
/** CoForge command recognition remains an embedding-host policy, with one scanner per turn. */
export interface GrokTurnHost {
  createReplyIntentScanner(): GrokReplyIntentScanner;
  isShellToolName(name: string): boolean;
}
export interface GrokConnectionHost {
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly sessionClientInfo: Readonly<{ name: string; version: string }>;
}
export interface GrokRuntimeHost extends GrokTurnHost, GrokConnectionHost {
  readonly catalogClientInfo: Readonly<{ name: string; version: string }>;
  readonly usageClientInfo: Readonly<{ name: string; version: string }>;
  readonly versionReader: CliVersionReader;
  buildSessionEnvironment(options: AgentSessionOptions): Record<string, string>;
  buildCatalogEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): Record<string, string>;
  buildUsageEnvironment(environment?: Readonly<Record<string, string>>): Record<string, string>;
  /** The host masks native account data before it becomes a public usage label. */
  maskAccountLabel(value: string): string | undefined;
}
export interface GrokProviderOptions {
  readonly host: GrokRuntimeHost;
  readonly command?: readonly string[];
  readonly acpTimeoutMs?: number;
}
