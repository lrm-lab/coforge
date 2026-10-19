import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/code-agent/contract";
import { ACP_TIMEOUT_MS, createGrokSession } from "./session";
import { assertGrokVersionSupported } from "./version";
import { readGrokUsage } from "./usage";

/**
 * Grok Build owns a persistent ACP session; this class keeps usage and the version gate.
 */
export class GrokProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.GROK;
  readonly #command: readonly string[];
  readonly #acpTimeoutMs: number;

  constructor(options: { command?: readonly string[]; acpTimeoutMs?: number } = {}) {
    this.#command = options.command ?? ["grok"];
    this.#acpTimeoutMs = options.acpTimeoutMs ?? ACP_TIMEOUT_MS;
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readGrokUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertGrokVersionSupported(this.#command);
    return createGrokSession(options, this.#command, this.#acpTimeoutMs);
  }
}
