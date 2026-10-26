import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";

export interface DshLaunchFiles {
  readonly patchPath: string;
  cleanup(): Promise<void>;
}

/** Native content is pure Anvil data; the host owns private files, environment and process trees. */
export interface DshRuntimeHost {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly versionReader: CliVersionReader;
  prepareLaunch(instructions: string): Promise<DshLaunchFiles>;
  buildEnvironment(options: AgentSessionOptions): Record<string, string>;
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

export interface DshProviderOptions {
  readonly host: DshRuntimeHost;
  readonly command?: readonly string[];
  /** Startup/config/cancellation waits only; prompt admission and full turns have no deadline. */
  readonly acpTimeoutMs?: number;
}
