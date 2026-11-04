import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { RuntimeMemoryUnsupportedError, type CodeAgentProvider } from "#src/contract";
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
    // A Memory Agent opens one session per conversation in a shared workspace, each with its
    // own briefing — one `.cursor/rules` file cannot hold them all, and cursor reads every
    // always-on rule in the directory. Refuse before any probe or file write.
    if (options.conversation || options.memoryControlSession)
      throw new RuntimeMemoryUnsupportedError(
        "Cursor cannot run a Memory Agent: its conversation sessions share one workspace, " +
          "so one .cursor/rules file cannot hold a different briefing for each",
      );
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
