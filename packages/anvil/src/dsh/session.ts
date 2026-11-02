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
import { dshConnection, DSH_ACP_TIMEOUT_MS, dshBounded } from "./connection";
import { dshCatalogFromConfig } from "./catalog";
import { DshTurnEvents } from "./update-events";
import type { DshLaunchFiles, DshProviderOptions } from "./host";

/** DSH's turn failure when no DeepSeek key is configured. It is reported as a plain unset key, which
 * the Computer files with every other runtime that needs a person to sign in; DSH's own text names
 * its internal credential service and is not shown. */
const DSH_MISSING_KEY = /\bno API key for provider route\b/i;
export const DSH_MISSING_KEY_MESSAGE = "DeepSeek API key is not set";

/** One native prompt at a time; local queue custody is never native acceptance. */
export class DshSession implements AgentSession {
  readonly #session: AcpSession;
  readonly #files: DshLaunchFiles;
  readonly #timeoutMs: number;
  #instructionsInvalid = false;

  constructor(
    command: readonly string[],
    private readonly options: AgentSessionOptions,
    private readonly providerOptions: DshProviderOptions,
    files: DshLaunchFiles,
  ) {
    this.#files = files;
    this.#timeoutMs = providerOptions.acpTimeoutMs ?? DSH_ACP_TIMEOUT_MS;
    this.#session = new AcpSession(this.#profile(command), options, this.#timeoutMs, dshBounded);
  }

  #profile(command: readonly string[]): AcpSessionProfile {
    const options = this.options;
    const providerOptions = this.providerOptions;
    return {
      label: "DSH",
      openTransport: (sink) => {
        const transport = dshConnection(
          command,
          options.agentWorkspaceDirectory,
          providerOptions.host.buildEnvironment(options),
          providerOptions.host,
          this.#files.patchPath,
          (sessionId, update) => sink.update(sessionId, update),
          (request) => sink.permission(request),
          () => sink.promptWritten(),
        );
        transport.process.onStderr((line) => {
          if (line.includes("DSH CoForge instructions must be a string"))
            this.#instructionsInvalid = true;
        });
        return transport;
      },
      openSession: async (transport, sessionId) => {
        const agent = transport.connection.agent;
        const cwd = options.agentWorkspaceDirectory;
        const resuming = sessionId !== undefined && options.sessionMode !== "create";
        const state = resuming
          ? await dshBounded(
              agent.request("session/resume", {
                sessionId: sessionId!,
                cwd,
                mcpServers: [],
              }),
              this.#timeoutMs,
            )
          : await dshBounded(
              agent.request("session/new", { cwd, mcpServers: [] }),
              this.#timeoutMs,
            );
        const created = resuming ? sessionId! : "sessionId" in state ? state.sessionId : undefined;
        if (typeof created !== "string" || !created.trim())
          throw new Error("DSH did not create a session");
        const config: SessionConfigOption[] = state.configOptions ?? [];
        const model = options.runtime?.model;
        if (model && model !== "default") {
          if (!dshCatalogFromConfig(config).models.some((entry) => entry.id === model))
            throw new RuntimeModelNotFoundError(model);
          await dshBounded(
            agent.request("session/set_config_option", {
              sessionId: created,
              configId: "model",
              value: model,
            }),
            this.#timeoutMs,
          );
        }
        const reasoning = options.runtime?.reasoning;
        if (reasoning)
          await dshBounded(
            agent.request("session/set_config_option", {
              sessionId: created,
              configId: "reasoning_effort",
              value: reasoning,
            }),
            this.#timeoutMs,
          );
        return { sessionId: created, resumable: resuming };
      },
      turn: () => new DshTurnEvents(providerOptions.host),
      cleanup: () => this.#files.cleanup(),
      detailMessage: (detail) =>
        DSH_MISSING_KEY.test(detail) ? DSH_MISSING_KEY_MESSAGE : undefined,
      afterInterrupt: () => this.#files.cleanup(),
    };
  }

  async open() {
    try {
      await this.#session.open();
    } catch (error) {
      if (this.#instructionsInvalid)
        throw new Error("DSH startup failed: required CoForge instructions must be a string", {
          cause: error,
        });
      throw error;
    }
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
