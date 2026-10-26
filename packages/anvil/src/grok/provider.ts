import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
import { type CodeAgentProvider } from "#src/contract";
import { ACP_TIMEOUT_MS, createGrokSession } from "./session";
import { assertGrokVersionSupported } from "./version";
import { readGrokUsage } from "./usage";
import type { GrokProviderOptions, GrokRuntimeHost } from "./host";

/**
 * Grok Build owns a persistent ACP session; this class keeps usage and the version gate.
 */
export class GrokProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.GROK;
  readonly #host: GrokRuntimeHost;
  readonly #command: readonly string[];
  readonly #acpTimeoutMs: number;

  constructor(options: GrokProviderOptions) {
    this.#host = options.host;
    this.#command = options.command ?? [RUNTIME_PROVIDER.GROK];
    this.#acpTimeoutMs = options.acpTimeoutMs ?? ACP_TIMEOUT_MS;
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readGrokUsage(
      options.workingDirectory,
      {
        command: this.#command,
        timeoutMs: options.timeoutMs,
      },
      this.#host,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertGrokVersionSupported(this.#command, this.#host.versionReader);
    return createGrokSession(options, this.#command, this.#acpTimeoutMs, this.#host);
  }
}
