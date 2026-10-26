import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider } from "#src/contract";
import { createPerTurnSession } from "#src/per-turn/session";
import type { AntigravityProviderOptions, AntigravityRuntimeHost } from "./host";
import { readAntigravityUsage } from "./usage";
import { createAntigravityTurnProtocol } from "./turn-protocol";
import { assertAntigravityVersionSupported } from "./version";

/**
 * Google's Antigravity CLI (`agy`) is a per-turn provider: `antigravity/turn-protocol.ts` says how
 * one turn is launched and read, and `createPerTurnSession` runs the session around it. This class
 * keeps usage and the version gate.
 */
export class AntigravityProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.ANTIGRAVITY;
  readonly #host: AntigravityRuntimeHost;
  readonly #command: readonly string[];

  constructor(options: AntigravityProviderOptions) {
    this.#host = options.host;
    this.#command = options.command ?? ["agy"];
  }

  async readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readAntigravityUsage(
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
    await assertAntigravityVersionSupported(this.#command, this.#host.versionReader);
    return createPerTurnSession(
      createAntigravityTurnProtocol(options, this.#command),
      options,
      this.#host.sessionHost,
    );
  }
}
