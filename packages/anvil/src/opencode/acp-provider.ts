import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { AgentEnvironmentError, type CodeAgentProvider } from "#src/contract";
import { createOpenCodeAcpSession } from "./acp-session";
import type { OpenCodeAcpProviderOptions, OpenCodeAcpRuntimeHost } from "./acp-host";
import { assertOpenCodeAcpVersionSupported } from "./acp-version";
import { createOpenCodeInstructions, openCodeConfigContentAlreadySet } from "./instructions";

/**
 * OpenCode through the official `opencode acp` ACP server: one persistent ACP process per Agent
 * session, resumed with `session/load`, standing instructions injected through a private
 * `OPENCODE_CONFIG_CONTENT` instructions file, and live-turn input queued until the turn ends
 * (`after_turn` — a second `session/prompt` while a turn runs is refused).
 */
export class OpenCodeAcpProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.OPENCODE;
  readonly reportsCompaction = false;
  readonly #host: OpenCodeAcpRuntimeHost;
  readonly #command: readonly string[];
  readonly #acpTimeoutMs: number | undefined;

  constructor(options: OpenCodeAcpProviderOptions) {
    this.#host = options.host;
    this.#command = options.command ?? [RUNTIME_PROVIDER.OPENCODE];
    this.#acpTimeoutMs = options.acpTimeoutMs;
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertOpenCodeAcpVersionSupported(this.#command, this.#host.versionReader);
    if (openCodeConfigContentAlreadySet(options)) {
      throw new AgentEnvironmentError(
        "OpenCode cannot start because OPENCODE_CONFIG_CONTENT is already set. CoForge will not overwrite it.",
      );
    }
    const instructions = await createOpenCodeInstructions(options.instructions);
    try {
      return await createOpenCodeAcpSession(
        options,
        this.#command,
        this.#host,
        instructions,
        this.#acpTimeoutMs,
      );
    } catch (error) {
      await instructions.remove().catch(() => undefined);
      throw error;
    }
  }
}
