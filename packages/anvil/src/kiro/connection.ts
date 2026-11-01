import { asRecord as record } from "#src/json-record";
import type { RuntimeLoginRequiredError } from "#src/contract";
import { acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile } from "#src/acp/profile";
import { isKiroAuthFailure, kiroLoginRequired } from "./auth-failure";
import type { KiroConnectionHost } from "./host";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
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

export const KIRO_PROFILE: AcpRuntimeProfile = {
  // Kiro's session already appends `KIRO_ACP_ARGS` to the resolved executable before it builds
  // this connection, so the profile adds none.
  args: [],
  readConfig: (update) =>
    update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)
      ? (update.configOptions as SessionConfigOption[])
      : undefined,
  configReady: (option, category) => configOffers([option], category),
  capabilityCheck: (response) => {
    if (
      !response.agentCapabilities?.loadSession ||
      !record(response.agentCapabilities._meta?.kiro)?.replayMarking
    )
      throw new Error("Kiro v3 ACP capabilities are unavailable; update kiro-cli");
  },
  messages: {
    unsupportedProtocol: "Unsupported Kiro ACP protocol version",
    closedBeforeConfig: "Kiro ACP process closed before configuration",
    timedOut: "Kiro ACP operation timed out",
  },
};

/**
 * Kiro's ACP connection: the shared process and client, plus Kiro's own login guard. Kiro reports
 * a login it cannot use on stderr and as a `displayError` session update rather than as an error
 * on the request it could not serve, so its handshake operations fail as
 * `RuntimeLoginRequiredError` the moment either says so.
 *
 * Its updates use the shared synchronous tap like every other ACP adapter; a steering outcome
 * that arrives before the `_session/steer` answer is kept by `KiroTurnSteering` until the steer
 * registers.
 */
export class KiroConnection {
  readonly #inner: AcpConnection;
  /** Set once the CLI says its login is not usable; every guarded handshake call then fails with
   * it instead of waiting out its own bound. */
  #authFailure: RuntimeLoginRequiredError | undefined;
  readonly #authFailureReported = Promise.withResolvers<RuntimeLoginRequiredError>();

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    host: KiroConnectionHost,
    onUpdate: (notification: SessionNotification) => void = () => {},
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
      outcome: { outcome: "cancelled" },
    }),
  ) {
    this.#inner = acpProcess(KIRO_PROFILE, {
      command,
      cwd,
      environment,
      clientInfo: host.clientInfo,
      processTreeSpawner: host.processTreeSpawner,
      onUpdate: (method, params) => {
        if (method !== "session/update") return;
        const notification = params as SessionNotification;
        this.#observeAuthFailure(notification.update);
        onUpdate(notification);
      },
      onPermission,
      onStderr: (line) => {
        if (this.#authFailure || !isKiroAuthFailure(line)) return;
        this.#fail();
      },
    });
  }

  get process() {
    return this.#inner.process;
  }

  get connection() {
    return this.#inner.connection;
  }

  get closed() {
    return this.#inner.closed;
  }

  async waitForConfig(
    sessionId: string,
    initial: SessionConfigOption[],
    category: string,
    timeoutMs = 30_000,
  ) {
    return this.guarded(
      this.#inner.waitForConfig(sessionId, initial, category, timeoutMs),
      timeoutMs,
    );
  }

  /**
   * A handshake request bounded by `timeoutMs` that fails as soon as Kiro says its login is not
   * usable, instead of waiting out the bound. A rejected login is terminal for the launch, so the
   * caller must see it as `RuntimeLoginRequiredError` rather than as a timeout or a closed
   * connection.
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
    this.#fail();
  }

  #fail(): void {
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

  async initialize() {
    return this.guarded(this.#inner.initialize());
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>) {
    return this.#inner.dispose(options);
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
