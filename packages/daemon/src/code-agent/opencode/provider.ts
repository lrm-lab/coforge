import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { createPerTurnSession } from "@lrm/coforge-anvil";
import { perTurnSessionHost } from "#src/code-agent/per-turn-host";
import { createOpenCodeTurnProtocol } from "./turn-protocol";
import { assertOpenCodeVersionSupported } from "./version";

/**
 * OpenCode (`opencode`, SST) is a per-turn provider: `opencode/turn-protocol.ts` says how one turn
 * is launched and read, and `createPerTurnSession` runs the session around it. This class keeps
 * the version gate.
 */
export class OpenCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.OPENCODE;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["opencode"];
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertOpenCodeVersionSupported(this.#command);
    return createPerTurnSession(
      createOpenCodeTurnProtocol(options, this.#command),
      options,
      perTurnSessionHost,
    );
  }
}
