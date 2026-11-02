import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
import { RuntimeModelNotFoundError } from "#src/contract";
import { asRecord } from "#src/json-record";
import type { AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import type { AcpConnection } from "#src/acp/connection";
import { devinConnection, DEVIN_ACP_TIMEOUT_MS, devinBounded } from "./connection";
import { DevinTurnEvents } from "./update-events";
import type { DevinProviderOptions } from "./host";
import { createDevinRuleFile, type DevinRuleFile } from "./rules";

/** Full access, matching every other runtime: no approval prompts for edits or commands. */
export const DEVIN_PERMISSION_MODE = "bypass";

/** One native prompt at a time; local queue custody is never native acceptance. */
export class DevinSession implements AgentSession {
  readonly #session: AcpSession;
  #rule: DevinRuleFile | undefined;
  readonly #timeoutMs: number;

  constructor(
    private readonly command: readonly string[],
    private readonly options: AgentSessionOptions,
    private readonly providerOptions: DevinProviderOptions,
  ) {
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? DEVIN_ACP_TIMEOUT_MS;
    this.#session = new AcpSession(this.#profile(), options, this.#timeoutMs, devinBounded);
  }

  #profile(): AcpSessionProfile {
    const { options, providerOptions, command } = {
      options: this.options,
      providerOptions: this.providerOptions,
      command: this.command,
    };
    return {
      label: "Devin",
      openTransport: (sink) =>
        devinConnection(
          command,
          options.agentWorkspaceDirectory,
          providerOptions.host.buildEnvironment(options),
          providerOptions.host,
          (sessionId, update) => sink.update(sessionId, update),
          (request) => sink.permission(request),
          () => sink.promptWritten(),
        ),
      openSession: async (transport, sessionId) => {
        const agent = transport.connection.agent;
        const cwd = options.agentWorkspaceDirectory;
        const resuming = sessionId !== undefined && options.sessionMode !== "create";
        let replacedSessionId: string | undefined;
        let created: string | undefined;
        let configOptions: SessionConfigOption[] = [];
        if (resuming) {
          try {
            const loaded = await devinBounded(
              agent.request("session/load", {
                sessionId: sessionId!,
                cwd,
                mcpServers: [],
              }),
              this.#timeoutMs,
            );
            created = sessionId;
            configOptions = loaded.configOptions ?? [];
          } catch (error) {
            if (!sessionGone(error)) throw error;
            replacedSessionId = sessionId;
          }
        }
        if (!created) {
          const fresh = await devinBounded(
            agent.request("session/new", { cwd, mcpServers: [] }),
            this.#timeoutMs,
          );
          created = fresh.sessionId;
          configOptions = fresh.configOptions ?? [];
        }
        if (!created.trim()) throw new Error("Devin did not create a session");
        // A session that cannot enter the full-access mode must not run under a prompting one.
        await devinBounded(
          agent.request("session/set_mode", {
            sessionId: created,
            modeId: DEVIN_PERMISSION_MODE,
          }),
          this.#timeoutMs,
        );
        await this.#applyRuntimeConfig(transport, created, configOptions);
        return {
          sessionId: created,
          resumable: resuming && !replacedSessionId,
          ...(replacedSessionId ? { replacedSessionId } : {}),
        };
      },
      turn: () => new DevinTurnEvents(providerOptions.host),
      cleanup: async () => {
        await this.#rule?.remove();
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
    const select = async (category: string, value: string) => {
      const option = config.find((entry) => entry.category === category);
      const id = option?.id ?? category;
      const available =
        option?.type === "select" &&
        option.options.some((entry) =>
          "value" in entry
            ? entry.value === value
            : entry.options.some((child) => child.value === value),
        );
      if (!available) {
        if (category === "model") throw new RuntimeModelNotFoundError(value);
        throw new Error(`Devin ${category} selection is unavailable`);
      }
      const configured = await devinBounded(
        transport.connection.agent.request("session/set_config_option", {
          sessionId,
          configId: id,
          value,
        }),
        this.#timeoutMs,
      );
      config = configured.configOptions;
      if (!config.some((entry) => entry.id === id && entry.currentValue === value))
        throw new Error(`Devin did not apply ${id}`);
    };
    if (model) {
      config = await transport.waitForConfig(sessionId, config, "model", this.#timeoutMs);
      await select("model", model);
    }
    // Effort options depend on the model that was just selected. When the returned option does
    // not exist, the model's own default stays. A present option that lacks the value fails.
    if (!reasoning) return;
    if (config.some((entry) => entry.category === "thought_level"))
      await select("thought_level", reasoning);
  }

  async open() {
    // Devin only reads an always-on rule at session start, so it must exist before session/new.
    this.#rule = await createDevinRuleFile(
      this.options.agentWorkspaceDirectory,
      this.options.instructions,
    );
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

/** A requested session Devin no longer has is replaced, the Codex recovery rule. Devin marks it
 * structurally (`-32016`, `data["cognition.ai/errorKind"]: "session_not_found"`, observed on CLI
 * 3000.11.228); any other failure (auth, protocol, transport) surfaces instead of silently
 * starting a new session. */
function sessionGone(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    asRecord(error.data)?.["cognition.ai/errorKind"] === "session_not_found"
  );
}
