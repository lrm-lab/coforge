import {
  client,
  type AnyMessage,
  type InitializeRequest,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { JsonlProcess } from "#src/jsonl-process";
import { asRecord } from "#src/json-record";
import { withDeadline } from "#src/deadline";
import type { ProcessTreeSpawner } from "#src/process-tree";
import type { AcpProfileMessages, AcpRuntimeProfile } from "./profile";

/** Connection identity and process ownership, supplied by the embedding host. */
export type AcpConnectionHost = {
  readonly clientInfo: Readonly<{ name: string; version: string }>;
  readonly processTreeSpawner: ProcessTreeSpawner;
};

export type AcpConnectionOptions = {
  /** The full argv, executable included. */
  command: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  host: AcpConnectionHost;
  messages: AcpProfileMessages;
  /** Reads a `config_option_update` into the options this runtime publishes; absent for a
   * runtime that never publishes configuration this way. */
  readConfig?(update: Readonly<Record<string, unknown>>): SessionConfigOption[] | undefined;
  /** Extra ACP notification methods this runtime publishes, observed like `session/update`. */
  notifications?: readonly string[];
  /** Each observed notification, synchronously, so it keeps its place before the response that
   * follows it. Raw params: each adapter validates what its runtime sends, and a runtime that
   * treats malformed params as a failure says so. */
  onUpdate?(method: string, params: unknown): void;
  onPermission?(request: RequestPermissionRequest): RequestPermissionResponse;
  /** Runs before a `session/prompt` frame is written, for a runtime that must know a turn
   * began. */
  onPromptWrite?(): void;
};

/**
 * One ACP runtime's process and client, built from its profile: the arguments the profile adds to
 * the resolved executable, the identity it announces, the notifications it publishes, and the
 * configuration it reads.
 */
export function acpProcess(
  profile: AcpRuntimeProfile,
  options: {
    /** The resolved executable. */
    command: readonly string[];
    /** Arguments this call adds after the profile's (a `--mod` or `--patch` path). */
    extraArgs?: readonly string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
    /** Identity this runtime's host announces for the connection. */
    clientInfo: Readonly<{ name: string; version: string }>;
    processTreeSpawner: ProcessTreeSpawner;
    onUpdate?(method: string, params: unknown): void;
    onPermission?(request: RequestPermissionRequest): RequestPermissionResponse;
    onPromptWrite?(): void;
  },
): AcpConnection {
  return new AcpConnection({
    command: [...options.command, ...profile.args, ...(options.extraArgs ?? [])],
    cwd: options.cwd,
    environment: options.environment,
    host: { clientInfo: options.clientInfo, processTreeSpawner: options.processTreeSpawner },
    messages: profile.messages,
    notifications: profile.notifications,
    readConfig: profile.readConfig,
    onUpdate: options.onUpdate,
    onPermission: options.onPermission,
    onPromptWrite: options.onPromptWrite,
  });
}

/**
 * One ACP runtime's connection: the JSONL child process, the ACP client wired to it, the
 * configuration the runtime publishes, and the initialize/dispose lifecycle every adapter shares.
 *
 * The ACP SDK validates RPC; the record tap here stays synchronous so an update observed before
 * a response is delivered before it, which every adapter's turn ordering depends on.
 */
export class AcpConnection {
  readonly process: JsonlProcess;
  readonly connection;
  readonly #config = new Map<string, SessionConfigOption[]>();
  readonly #configChanged = new Set<() => void>();
  #closed = false;

  constructor(private readonly options: AcpConnectionOptions) {
    const { host } = options;
    this.process = new JsonlProcess(
      options.command,
      options.cwd,
      options.environment,
      host.processTreeSpawner,
    );
    this.connection = client({ name: host.clientInfo.name })
      .onNotification("session/update", () => {})
      .onRequest("session/request_permission", ({ params }) => {
        return options.onPermission?.(params) ?? { outcome: { outcome: "cancelled" } };
      })
      .connect({
        readable: this.process.records((record) => {
          if (
            record.method !== "session/update" &&
            !options.notifications?.includes(String(record.method))
          )
            return;
          // Each adapter reads and validates the fields its runtime publishes; the shared tap
          // only decides which methods are observed and keeps them in arrival order.
          const params = asRecord(record.params);
          const update = asRecord(params?.update);
          const config = update ? options.readConfig?.(update) : undefined;
          if (config && typeof params?.sessionId === "string") {
            this.#config.set(params.sessionId, config);
            for (const listener of this.#configChanged) listener();
          }
          options.onUpdate?.(String(record.method), record.params);
        }) as ReadableStream<AnyMessage>,
        writable: new WritableStream<AnyMessage>({
          write: (message) => {
            if ("method" in message && message.method === "session/prompt")
              options.onPromptWrite?.();
            return this.process.send(message);
          },
        }),
      });
    // The readable stream ends with the process. Wake config waiters then, or a dead catalog
    // probe sits in the inventory refresh until the deadline.
    void this.connection.closed.then(() => this.#close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  async waitForConfig(
    sessionId: string,
    initial: SessionConfigOption[],
    category: string,
    timeoutMs: number,
  ): Promise<SessionConfigOption[]> {
    const ready = (options: SessionConfigOption[]) =>
      options.some((option) => selectReady(option, category));
    if (ready(initial)) return initial;
    let check: () => void = () => {};
    try {
      return await this.bounded(
        new Promise<SessionConfigOption[]>((resolve, reject) => {
          check = () => {
            if (this.#closed) return reject(new Error(this.options.messages.closedBeforeConfig));
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

  async initialize(timeoutMs?: number): Promise<InitializeResponse> {
    const work = this.connection.agent.request<InitializeResponse, InitializeRequest>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: this.options.host.clientInfo,
      },
    );
    const response = timeoutMs === undefined ? await work : await this.bounded(work, timeoutMs);
    if (response.protocolVersion !== 1) throw new Error(this.options.messages.unsupportedProtocol);
    return response;
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    this.#close();
    await this.process.dispose(options);
  }

  /** One ACP operation on this runtime's own deadline, named as this runtime names it. */
  bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    return withDeadline(work, timeoutMs, () => new Error(this.options.messages.timedOut));
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.connection.close();
    for (const listener of this.#configChanged) listener();
    this.#config.clear();
  }
}

/** One ACP operation on `message`'s deadline, for work that outlives a single connection. */
export function acpBounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return withDeadline(work, timeoutMs, () => new Error(message));
}

function selectReady(option: SessionConfigOption, category: string): boolean {
  return (option.category === category || option.id === category) && option.type === "select";
}
