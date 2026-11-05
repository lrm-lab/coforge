import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";

/** What the daemon supplies the Droid ACP session: process trees, the session environment, the
 * `droid --version` probe, and reply-intent policies that stay host decisions. */
export interface DroidAcpRuntimeHost {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly versionReader: CliVersionReader;
  /** A bounded tail of the runtime's stderr, delivered once when its process closes — the lines
   * a crash or a silent exit reports only there. */
  stderrHint?(lines: readonly string[]): void;
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

export interface DroidAcpProviderOptions {
  readonly host: DroidAcpRuntimeHost;
  readonly command?: readonly string[];
  /** Startup/config waits only; prompt admission and full turns have no deadline. */
  readonly acpTimeoutMs?: number;
}
