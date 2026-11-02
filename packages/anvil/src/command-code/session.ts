import { dirname, join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
import { RuntimeModelNotFoundError } from "#src/contract";
import type { AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import type { AcpConnection } from "#src/acp/connection";
import {
  commandCodeConnection,
  COMMAND_CODE_ACP_TIMEOUT_MS,
  commandCodeBounded,
} from "./connection";
import { CommandCodeTurnEvents } from "./update-events";
import type { CommandCodeProviderOptions } from "./host";
import {
  COMMAND_CODE_INSTRUCTION_MOD_LOADED,
  createCommandCodeInstructionMod,
  type CommandCodeInstructionMod,
} from "./instructions-mod";
import { COMMAND_CODE_MIN_CLI_VERSION } from "./version";

/** One native prompt at a time; local queue custody is never native acceptance. */
export class CommandCodeSession implements AgentSession {
  readonly #session: AcpSession;
  #mod: CommandCodeInstructionMod | undefined;
  readonly #timeoutMs: number;

  constructor(
    private readonly command: readonly string[],
    private readonly options: AgentSessionOptions,
    private readonly providerOptions: CommandCodeProviderOptions,
  ) {
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? COMMAND_CODE_ACP_TIMEOUT_MS;
    this.#session = new AcpSession(this.#profile(), options, this.#timeoutMs, commandCodeBounded);
  }

  #profile(): AcpSessionProfile {
    const options = this.options;
    const providerOptions = this.providerOptions;
    const command = this.command;
    const timeoutMs = this.#timeoutMs;
    return {
      label: "Command Code",
      openTransport: (sink) =>
        commandCodeConnection(
          command,
          this.#mod?.modPath,
          options.agentWorkspaceDirectory,
          providerOptions.host.buildEnvironment(options),
          providerOptions.host,
          (sessionId, update) => sink.update(sessionId, update),
          (request) => sink.permission(request),
          () => sink.promptWritten(),
        ),
      openSession: async (transport, sessionId) => {
        if (!this.#mod) throw new Error("Command Code instruction mod is not prepared");
        const loaded = join(dirname(this.#mod.modPath), COMMAND_CODE_INSTRUCTION_MOD_LOADED);
        if (!(await Bun.file(loaded).exists()))
          throw new Error(
            `Command Code did not load the instruction mod. A CLI older than ${COMMAND_CODE_MIN_CLI_VERSION} ignores --mod on cmd acp, and a mods.disableAll setting skips --mod, so the standing instructions would be missing.`,
          );
        const cwd = options.agentWorkspaceDirectory;
        const resuming = sessionId !== undefined && options.sessionMode !== "create";
        const state = resuming
          ? await commandCodeBounded(
              transport.connection.agent.request("session/resume", {
                sessionId: sessionId!,
                cwd,
                mcpServers: [],
              }),
              timeoutMs,
            )
          : await commandCodeBounded(
              transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
              timeoutMs,
            );
        const created = resuming ? sessionId! : "sessionId" in state ? state.sessionId : undefined;
        if (typeof created !== "string" || !created.trim())
          throw new Error("Command Code did not create a session");
        await this.#applyRuntimeConfig(transport, created, state.configOptions ?? []);
        return { sessionId: created, resumable: resuming };
      },
      turn: () => new CommandCodeTurnEvents(providerOptions.host),
      cleanup: async () => {
        await this.#mod?.remove();
      },
    };
  }

  async #applyRuntimeConfig(
    transport: AcpConnection,
    sessionId: string,
    initial: SessionConfigOption[],
  ) {
    const model = this.options.runtime?.model;
    const reasoning = this.options.runtime?.reasoning;
    if (!model && !reasoning) return;
    let config = initial;
    const select = async (id: string, value: string) => {
      const option = config.find((entry) => entry.id === id);
      const available =
        option?.type === "select" &&
        option.options.some((entry) =>
          "value" in entry
            ? entry.value === value
            : entry.options.some((child) => child.value === value),
        );
      if (!available) {
        if (id === "model") throw new RuntimeModelNotFoundError(value);
        throw new Error(`Command Code ${id} selection is unavailable`);
      }
      const configured = await commandCodeBounded(
        transport.connection.agent.request("session/set_config_option", {
          sessionId,
          configId: id,
          value,
        }),
        this.#timeoutMs,
      );
      config = configured.configOptions;
      if (!config.some((entry) => entry.id === id && entry.currentValue === value))
        throw new Error(`Command Code did not apply ${id}`);
    };
    if (model) {
      config = await transport.waitForConfig(sessionId, config, "model", this.#timeoutMs);
      await select("model", model);
    }
    // Effort options depend on the model that was just selected. When the returned option does
    // not exist, the model's own default stays. A present option that lacks the value fails.
    if (!reasoning) return;
    const effort = config.find((entry) => entry.category === "thought_level");
    if (effort) await select(effort.id, reasoning);
  }

  async open() {
    this.#mod = await createCommandCodeInstructionMod(this.options.instructions);
    await this.#session.open();
  }

  get hasLiveTurn() {
    return this.#session.hasLiveTurn;
  }
  sendMessage(text: string) {
    return this.#session.sendMessage(text);
  }
  notify(text: string, options?: AgentNoticeOptions) {
    return this.#session.notify(text, options);
  }
  cancelPendingNotices() {
    this.#session.cancelPendingNotices();
  }
  interrupt() {
    return this.#session.interrupt();
  }
  readSessionIdentity() {
    return this.#session.readSessionIdentity();
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    return this.#session.subscribe(listener);
  }
  onExit(listener: () => void) {
    return this.#session.onExit(listener);
  }
  dispose(options?: Readonly<{ cutoffAtMs?: number }>) {
    return this.#session.dispose(options);
  }
}
