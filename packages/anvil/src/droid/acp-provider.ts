import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "#src/contract";
import { createDroidAcpSession } from "./acp-session";
import type { DroidAcpProviderOptions, DroidAcpRuntimeHost } from "./acp-host";
import { assertDroidAcpVersionSupported } from "./acp-version";
import { createDroidInstructions } from "./instructions";
import { readDroidUsage } from "./usage";

/**
 * Factory Droid through its own ACP server (`droid exec --output-format acp`): one persistent ACP
 * process per Agent session, resumed with `session/load`, standing instructions passed as a
 * private `--append-system-prompt-file`, and live-turn input queued until the turn ends
 * (`after_turn` — the server has no steer request, and `session/cancel` is not implemented).
 */
export class DroidAcpProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.DROID;
  readonly compactionFailure = "does_not_stick";
  readonly reportsCompaction = false;
  readonly #host: DroidAcpRuntimeHost;
  readonly #command: readonly string[];
  readonly #acpTimeoutMs: number | undefined;
  /** Plan usage exists only when the host supplies the interactive-TUI reader; without one the
   * provider advertises no `readUsage`, matching `RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN`. */
  readonly readUsage?: CodeAgentProvider["readUsage"];

  constructor(options: DroidAcpProviderOptions) {
    this.#host = options.host;
    this.#command = options.command ?? [RUNTIME_PROVIDER.DROID];
    this.#acpTimeoutMs = options.acpTimeoutMs;
    const usageHost = options.usageHost;
    if (usageHost) {
      this.readUsage = (usage) => readDroidUsage(usage, usageHost);
    }
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertDroidAcpVersionSupported(this.#command, this.#host.versionReader);
    const instructions = options.instructions
      ? await createDroidInstructions(options.instructions)
      : undefined;
    try {
      return await createDroidAcpSession(
        options,
        this.#command,
        this.#host,
        instructions,
        this.#acpTimeoutMs,
      );
    } catch (error) {
      await instructions?.remove();
      throw error;
    }
  }
}
