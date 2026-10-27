import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";

export interface CommandCodeRuntimeHost {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly versionReader: CliVersionReader;
  buildEnvironment(options: AgentSessionOptions): Record<string, string>;
  buildCatalogEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): Record<string, string>;
  createReplyIntentScanner(): {
    feed(delta: {
      callId: string;
      fragment: string;
    }): Extract<AgentRuntimeEvent, { type: "reply-intent" }> | undefined;
    complete(callId: string): void;
    reset(): string[];
  };
  isShellToolName(name: string): boolean;
}
export interface CommandCodeProviderOptions {
  readonly host: CommandCodeRuntimeHost;
  readonly command?: readonly string[];
  readonly acpTimeoutMs?: number;
}
