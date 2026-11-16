import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider } from "#src/contract";
import { createCursorAcpSession } from "./acp-session";
import type { CursorAcpProviderOptions, CursorAcpRuntimeHost } from "./acp-host";
import { assertCursorAcpVersionSupported } from "./acp-version";
import { createCursorInstructions } from "./instructions";

/**
 * Cursor through the official `cursor-agent acp` ACP server: one persistent ACP process per
 * Agent session, resumed with `session/load` (which replays the stored conversation), standing
 * instructions injected through a private `.cursor/rules` file, and live-turn input steered
 * into the running turn (`direct` — a second `session/prompt` merges into the live one).
 */
export class CursorAcpProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CURSOR;
  readonly compactionFailure = "does_not_stick";
  readonly reportsCompaction = false;
  readonly #host: CursorAcpRuntimeHost;
  readonly #command: readonly string[];
  readonly #acpTimeoutMs: number | undefined;

  constructor(options: CursorAcpProviderOptions) {
    this.#host = options.host;
    this.#command = options.command ?? ["cursor-agent"];
    this.#acpTimeoutMs = options.acpTimeoutMs;
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertCursorAcpVersionSupported(this.#command, this.#host.versionReader);
    const instructions = options.instructions
      ? await createCursorInstructions(options.agentWorkspaceDirectory, options.instructions)
      : undefined;
    try {
      return await createCursorAcpSession(
        options,
        this.#command,
        this.#host,
        instructions,
        this.#acpTimeoutMs,
      );
    } catch (error) {
      await instructions?.remove().catch(() => undefined);
      throw error;
    }
  }
}
