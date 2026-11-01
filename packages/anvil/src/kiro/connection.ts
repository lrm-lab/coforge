import { asRecord as record } from "#src/json-record";
import { JsonlProcess } from "#src/jsonl-process";
import type { RuntimeLoginRequiredError } from "#src/contract";
import { isKiroAuthFailure, kiroLoginRequired } from "./auth-failure";
import type { KiroConnectionHost } from "./host";
import {
  client,
  type AnyMessage,
  type InitializeRequest,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

export const KIRO_ACP_ARGS = ["acp", "--agent-engine", "v3", "--auth-method", "cli"] as const;

/** Compatibility baseline: `--auth-method` and the v3 engine require at least this
 * kiro-cli release. Older CLIs reject `--auth-method` outright, so runtime discovery must gate on
 * this version before ever offering the Kiro runtime. */
export const KIRO_MIN_CLI_VERSION = "2.21.2";

/** How long an elicited configuration answer may take to report a rejected login. The
 * `displayError` arrives with the answer, so this only bounds a dispatch delay. */
export const AUTH_DIAGNOSIS_WAIT_MS = 2_000;

/** Whether a session's configuration offers a usable selection for `category`. */
export function configOffers(options: SessionConfigOption[], category: string): boolean {
  return options.some(
    (option) =>
      (option.category === category || option.id === category) &&
      option.type === "select" &&
      option.options.some((entry) => "value" in entry || entry.options.length > 0),
  );
}

/** ACP owns RPC framing/validation; JsonlProcess retains the existing process-tree lifecycle. */
export class KiroConnection {
  readonly process: JsonlProcess;
  readonly connection;
  readonly #config = new Map<string, SessionConfigOption[]>();
  readonly #configChanged = new Set<() => void>();
  /** Set once the CLI says on stderr that its login is not usable; every guarded handshake call
   * then fails with it instead of waiting out its own bound. */
  #authFailure: RuntimeLoginRequiredError | undefined;
  readonly #authFailureReported = Promise.withResolvers<RuntimeLoginRequiredError>();
  #closed = false;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    private readonly host: KiroConnectionHost,
    onUpdate: (notification: SessionNotification) => void = () => {},
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
      outcome: { outcome: "cancelled" },
    }),
  ) {
    this.process = new JsonlProcess(command, cwd, environment, host.processTreeSpawner);
    this.process.onStderr((line) => {
      if (this.#authFailure || !isKiroAuthFailure(line)) return;
      this.#authFailure = kiroLoginRequired();
      this.#authFailureReported.resolve(this.#authFailure);
    });
    this.connection = client({ name: host.clientInfo.name })
      .onNotification("session/update", ({ params }) => {
        this.#observeAuthFailure(params.update);
        if (params.update.sessionUpdate === "config_option_update") {
          this.#config.set(params.sessionId, params.update.configOptions);
          for (const listener of this.#configChanged) listener();
        }
        onUpdate(params);
      })
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        readable: this.process.records() as ReadableStream<AnyMessage>,
        writable: new WritableStream<AnyMessage>({
          write: (message) => this.process.send(message),
        }),
      });
    // The stream ends when the process does and the SDK closes the connection once it has
    // handled everything still queued, so a response written just before an exit is not lost.
    void this.connection.closed.then(() => this.#close());
  }

  async waitForConfig(
    sessionId: string,
    initial: SessionConfigOption[],
    category: string,
    timeoutMs = 30_000,
  ) {
    const ready = (options: SessionConfigOption[]) => configOffers(options, category);
    if (ready(initial)) return initial;
    let check: () => void = () => {};
    try {
      return await this.guarded(
        new Promise<SessionConfigOption[]>((resolve, reject) => {
          check = () => {
            if (this.#closed)
              return reject(new Error("Kiro ACP process closed before configuration"));
            const options = this.#config.get(sessionId);
            if (options && ready(options)) resolve(options);
          };
          this.#configChanged.add(check);
          check();
        }),
        timeoutMs,
      );
    } finally {
      this.#configChanged.delete(check);
    }
  }

  /**
   * A handshake request bounded by `timeoutMs` that fails as soon as Kiro says its login is not
   * usable on stderr, instead of waiting out the bound. A rejected login is terminal for the
   * launch, so the caller must see it as `RuntimeLoginRequiredError` rather than as a timeout or
   * a closed connection.
   */
  async guarded<T>(work: Promise<T>, timeoutMs = 30_000): Promise<T> {
    try {
      return await bounded(this.#guardAuth(work), timeoutMs);
    } catch (error) {
      if (this.#authFailure) throw this.#authFailure;
      throw error;
    }
  }

  /** `work`, settled as the CLI's rejected login the moment it reports one. */
  async #guardAuth<T>(work: Promise<T>): Promise<T> {
    if (this.#authFailure) throw this.#authFailure;
    type Outcome = { value: T } | { failure: RuntimeLoginRequiredError };
    const outcome: Outcome = await Promise.race([
      work.then((value): Outcome => ({ value })),
      this.#authFailureReported.promise.then((failure): Outcome => ({ failure })),
    ]);
    if ("failure" in outcome) throw outcome.failure;
    return outcome.value;
  }

  /**
   * Kiro reports a login it cannot use as a `displayError` on the session rather than as an error
   * on the request it could not serve (measured against kiro-cli 2.33.1, 2026-11-01: a model
   * selection answers successfully and the next update carries "Authentication failed. Please
   * sign in again."). It is the same terminal fact the stderr line reports.
   */
  #observeAuthFailure(update: SessionNotification["update"]): void {
    if (this.#authFailure || update.sessionUpdate !== "session_info_update") return;
    const message = record(record(update._meta?.kiro)?.displayError)?.message;
    if (typeof message !== "string" || !isKiroAuthFailure(message)) return;
    this.#authFailure = kiroLoginRequired();
    this.#authFailureReported.resolve(this.#authFailure);
  }

  /**
   * Asks Kiro for a configuration it may not be able to serve, so a rejected login is reported
   * now instead of as a missing option after the configuration deadline. Kiro answers the request
   * itself successfully; the reason rides the next session update. Bounded by
   * `AUTH_DIAGNOSIS_WAIT_MS`: when no rejected login is reported, the caller keeps its ordinary
   * wait and nothing about a healthy runtime changes.
   */
  async elicitAuthFailure(sessionId: string, configId: string, value: string): Promise<void> {
    await this.guarded(
      this.connection.agent.request("session/set_config_option", { sessionId, configId, value }),
      AUTH_DIAGNOSIS_WAIT_MS,
    ).catch(() => {});
    // The reason rides the notification stream right after the answer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#authFailureReported.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, AUTH_DIAGNOSIS_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#authFailure) throw this.#authFailure;
  }

  #close() {
    this.#closed = true;
    this.connection.close();
    for (const listener of this.#configChanged) listener();
    this.#config.clear();
  }

  async initialize() {
    const request: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: this.host.clientInfo,
    };
    const response = await this.guarded(this.connection.agent.request("initialize", request));
    if (
      response.protocolVersion !== 1 ||
      !response.agentCapabilities?.loadSession ||
      !record(response.agentCapabilities._meta?.kiro)?.replayMarking
    ) {
      throw new Error("Kiro v3 ACP capabilities are unavailable; update kiro-cli");
    }
    return response;
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>) {
    this.#close();
    await this.process.dispose(options);
  }
}

export async function bounded<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kiro ACP operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { record };
