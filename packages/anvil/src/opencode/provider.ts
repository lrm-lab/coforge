import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { AgentEnvironmentError, type CodeAgentProvider } from "#src/contract";
import { createPerTurnSession, type PerTurnSessionHost } from "#src/per-turn/session";
import type { CliVersionReader } from "#src/version-gate";
import {
  createOpenCodeInstructions,
  openCodeConfigContentAlreadySet,
  type OpenCodeInstructions,
} from "./instructions";
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
    if (openCodeConfigContentAlreadySet(options)) {
      throw new AgentEnvironmentError(
        "OpenCode cannot start because OPENCODE_CONFIG_CONTENT is already set. CoForge will not overwrite it.",
      );
    }
    const instructions = await createOpenCodeInstructions(options.instructions);
    try {
      const session = await createPerTurnSession(
        createOpenCodeTurnProtocol(options, this.#command, instructions.configContent),
        options,
        this.#host,
      );
      return new OpenCodeAgentSession(session, instructions);
    } catch (error) {
      await instructions.remove().catch(() => undefined);
      throw error;
    }
  }
}

/** Deletes the private instructions directory when the per-turn session ends or its dispose fails. */
class OpenCodeAgentSession implements AgentSession {
  constructor(
    private readonly inner: AgentSession,
    private readonly instructions: OpenCodeInstructions,
  ) {}

  get hasLiveTurn(): boolean | undefined {
    return this.inner.hasLiveTurn;
  }

  sendMessage(message: string): Promise<void> {
    return this.inner.sendMessage(message);
  }

  notify(notice: string, options?: AgentNoticeOptions): Promise<void> {
    return this.inner.notify!(notice, options);
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    return this.inner.subscribe(listener);
  }

  readSessionIdentity(): Promise<AgentSessionIdentity | undefined> {
    return this.inner.readSessionIdentity!();
  }

  interrupt(): Promise<void> {
    return this.inner.interrupt();
  }

  onExit(listener: () => void): () => void {
    return this.inner.onExit(listener);
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    try {
      await this.inner.dispose(options);
    } finally {
      await this.instructions.remove();
    }
  }
}
