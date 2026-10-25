import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/contract";
import { createPerTurnSession, type PerTurnSessionHost } from "#src/per-turn/session";
import type { CliVersionReader } from "#src/version-gate";
import { createOpenCodeTurnProtocol } from "./turn-protocol";
import { assertOpenCodeVersionSupported } from "./version";

/**
 * OpenCode (`opencode`, SST) is a per-turn provider: `opencode/turn-protocol.ts` says how one turn
 * is launched and read, and `createPerTurnSession` runs the session around it. This class keeps
 * the version gate.
 */
export class OpenCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.OPENCODE;
  readonly #host: PerTurnSessionHost;
  readonly #versionReader: CliVersionReader;
  readonly #command: readonly string[];

  constructor(options: {
    command?: readonly string[];
    host: PerTurnSessionHost;
    versionReader: CliVersionReader;
  }) {
    this.#host = options.host;
    this.#versionReader = options.versionReader;
    this.#command = options.command ?? [RUNTIME_PROVIDER.OPENCODE];
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertOpenCodeVersionSupported(this.#command, this.#versionReader);
    return createPerTurnSession(
      createOpenCodeTurnProtocol(options, this.#command),
      options,
      this.#host,
    );
  }
}
