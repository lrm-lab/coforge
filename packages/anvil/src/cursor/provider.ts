import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/contract";
import { createPerTurnSession, type PerTurnSessionHost } from "#src/per-turn/session";
import { createCursorTurnProtocol } from "./turn-protocol";

/**
 * Cursor CLI (`cursor-agent`) is a per-turn provider: `cursor/turn-protocol.ts` says how one turn
 * is launched and read, and `createPerTurnSession` runs the session around it.
 */
export class CursorProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CURSOR;
  readonly #host: PerTurnSessionHost;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[]; host: PerTurnSessionHost }) {
    this.#host = options.host;
    this.#command = options.command ?? ["cursor-agent"];
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    return createPerTurnSession(
      createCursorTurnProtocol(options, this.#command),
      options,
      this.#host,
    );
  }
}
