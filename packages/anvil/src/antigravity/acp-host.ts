import type { AgentRuntimeEvent, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { CliVersionReader } from "#src/version-gate";
import type { CatalogCommandRunner } from "#src/catalog-command";

/** What the daemon supplies the Antigravity ACP session: process trees, the session environment,
 * the `agy --version` probe, account-usage execution, and reply-intent policies that stay host
 * decisions. */
export interface AntigravityAcpRuntimeHost {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
  readonly versionReader: CliVersionReader;
  readonly catalogCommandRunner: CatalogCommandRunner;
  /** Whether the ACP/CLI credential store already contains an account. This probe never spawns. */
  readonly readUsageAuthStatus?: () => Promise<boolean>;
  /**
   * Reads quota through the same ACP server that Agent sessions use. The official ACP server
   * currently exposes no quota method, so production hosts may omit this and the scan answers
   * unavailable instead of falling back to the interactive CLI (which can open OAuth).
   */
  readonly readAcpUsage?: (options: {
    workingDirectory: string;
    timeoutMs?: number;
    command?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
  }) => Promise<UsageSnapshot>;
  /** A bounded tail of the runtime's stderr, delivered once when its process closes — the lines
   * a crash or a silent exit reports only there. */
  stderrHint?(lines: readonly string[]): void;
  /** Called at usage-read time, never cached during provider construction. */
  readUsageEnvironment(): Readonly<Record<string, string | undefined>>;
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

export interface AntigravityAcpProviderOptions {
  readonly host: AntigravityAcpRuntimeHost;
  readonly command?: readonly string[];
  /** Native tool names the session envelope disables — the ACP-era stand-in for the CLI's SSH
   * tool filtering. Kept optional until the launch set is verified on a real server. */
  readonly disabledTools?: readonly string[];
  /** Startup/config waits only; prompt admission and full turns have no deadline. */
  readonly acpTimeoutMs?: number;
}
