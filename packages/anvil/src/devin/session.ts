import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type {
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionExit,
  AgentSessionOptions,
  AgentTurnProcessWindow,
} from "@coforge/agent";
import { asRecord } from "#src/json-record";
import type { AcpSessionProfile } from "#src/acp/profile";
import { acpApplyRuntimeConfig } from "#src/acp/config-options";
import { AcpSession } from "#src/acp/session";
import type { AcpConnection } from "#src/acp/connection";
import { DEVIN_PROFILE, devinConnection, DEVIN_ACP_TIMEOUT_MS, devinBounded } from "./connection";
import { DevinTurnEvents } from "./update-events";
import type { DevinProviderOptions } from "./host";
import { createDevinRuleFile, type DevinRuleFile } from "./rules";

/** Full access, matching every other runtime: no approval prompts for edits or commands. */
export const DEVIN_PERMISSION_MODE = "bypass";

/** One native prompt at a time; local queue custody is never native acceptance. */
export class DevinSession implements AgentSession {
  readonly #session: AcpSession;
  get processId(): number | undefined {
    return this.#session.processId;
  }
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
    const runtime = this.options.runtime;
    const config = runtime?.model
      ? await transport.waitForConfig(sessionId, initial, "model", this.#timeoutMs)
      : initial;
    await acpApplyRuntimeConfig(
      {
        transport,
        sessionId,
        timeoutMs: this.#timeoutMs,
        timedOut: DEVIN_PROFILE.messages.timedOut,
        label: "Devin",
      },
      config,
      runtime,
    );
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
  /** The wrapped ACP session declares steer support from its profile (Devin's has none). */
  get steersBusyTurn() {
    return this.#session.steersBusyTurn;
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

  killTurnProcesses(window: AgentTurnProcessWindow) {
    return this.#session.killTurnProcesses(window);
  }
  readSessionIdentity() {
    return this.#session.readSessionIdentity();
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    return this.#session.subscribe(listener);
  }
  onExit(listener: (exit?: AgentSessionExit) => void) {
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
