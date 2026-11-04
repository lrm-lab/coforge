import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/contract";
import { createAntigravityAcpSession } from "./acp-session";
import type { AntigravityAcpProviderOptions, AntigravityAcpRuntimeHost } from "./acp-host";
import { assertAntigravityAcpVersionSupported } from "./acp-version";
import { readAntigravityUsage } from "./usage";

/**
 * Antigravity through the official `agy acp` ACP server: one persistent ACP process per Agent
 * session, resumed with `session/load`, standing instructions injected through
 * `_meta.antigravity.systemPrompt.append`, and live-turn input sent as a steering prompt.
 */
export class AntigravityAcpProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.ANTIGRAVITY;
  readonly reportsCompaction = false;
  readonly #options: AntigravityAcpProviderOptions;
  readonly #host: AntigravityAcpRuntimeHost;
  readonly #command: readonly string[];

  constructor(options: AntigravityAcpProviderOptions) {
    this.#options = options;
    this.#host = options.host;
    this.#command = options.command ?? ["agy"];
  }

  async readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readAntigravityUsage(
      options.workingDirectory,
      { command: this.#command, timeoutMs: options.timeoutMs },
      this.#host,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertAntigravityAcpVersionSupported(this.#command, this.#host.versionReader);
    return createAntigravityAcpSession(
      options,
      this.#command,
      this.#host,
      this.#options.disabledTools,
      this.#options.acpTimeoutMs,
    );
  }
}
