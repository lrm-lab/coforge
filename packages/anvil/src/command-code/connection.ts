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
import type { CommandCodeRuntimeHost } from "./host";

export const COMMAND_CODE_ACP_ARGS = ["acp"] as const;
export const COMMAND_CODE_ACP_TIMEOUT_MS = 120_000;

/** ACP SDK validates RPC; synchronous observation preserves update-before-response ordering. */
export class CommandCodeConnection {
  readonly process: JsonlProcess;
  readonly connection;
  readonly #config = new Map<string, SessionConfigOption[]>();
  readonly #configChanged = new Set<() => void>();
  #closed = false;
  constructor(
    command: readonly string[],
    modPath: string | undefined,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    private readonly host: CommandCodeRuntimeHost,
    onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
      outcome: { outcome: "cancelled" },
    }),
    onPromptWrite: () => void = () => {},
  ) {
    // `--mod` is global and applies after `acp`. A catalog probe passes no mod path: the model
    // list is on session/new and does not need the instruction hook. `--safe-mode` would skip
    // `--mod`, so a real session never sets it.
    const argv = [...command, ...COMMAND_CODE_ACP_ARGS];
    if (modPath) argv.push("--mod", modPath);
    this.process = new JsonlProcess(argv, cwd, environment, host.processTreeSpawner);
    this.connection = client({ name: host.clientInfo.name })
      .onNotification("session/update", () => {})
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        readable: this.process.records((record) => {
          if (record.method !== "session/update") return;
          const params = asRecord(record.params);
          const update = asRecord(params?.update);
          if (typeof params?.sessionId !== "string" || !update) return;
          const config = readConfigOptions(update);
          if (config) {
            this.#config.set(params.sessionId, config);
            for (const listener of this.#configChanged) listener();
          }
          onUpdate(params.sessionId, update);
        }) as ReadableStream<AnyMessage>,
        writable: new WritableStream<AnyMessage>({
          write: (message) => {
            if ("method" in message && message.method === "session/prompt") onPromptWrite();
            return this.process.send(message);
          },
        }),
      });
    // The readable stream ends with the process. Wake config waiters then, or a dead
    // catalog probe sits in the inventory refresh until the deadline.
    void this.connection.closed.then(() => this.#close());
  }
  get closed() {
    return this.#closed;
  }
  async waitForConfig(
    sessionId: string,
    initial: SessionConfigOption[],
    category: string,
    timeoutMs = COMMAND_CODE_ACP_TIMEOUT_MS,
  ) {
    const ready = (options: SessionConfigOption[]) =>
      options.some((option) => selectReady(option, category));
    if (ready(initial)) return initial;
    let check: () => void = () => {};
    try {
      return await commandCodeBounded(
        new Promise<SessionConfigOption[]>((resolve, reject) => {
          check = () => {
            if (this.#closed)
              return reject(new Error("Command Code ACP process closed before configuration"));
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
  async initialize(timeoutMs = COMMAND_CODE_ACP_TIMEOUT_MS) {
    const response = await commandCodeBounded(
      this.connection.agent.request<InitializeResponse, InitializeRequest>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: this.host.clientInfo,
      }),
      timeoutMs,
    );
    if (response.protocolVersion !== 1)
      throw new Error("Unsupported Command Code ACP protocol version");
    return response;
  }
  async dispose(options?: Readonly<{ cutoffAtMs?: number }>) {
    this.#close();
    await this.process.dispose(options);
  }
  #close() {
    if (this.#closed) return;
    this.#closed = true;
    this.connection.close();
    for (const listener of this.#configChanged) listener();
    this.#config.clear();
  }
}

function selectReady(option: SessionConfigOption, category: string) {
  return (option.category === category || option.id === category) && option.type === "select";
}

function readConfigOptions(
  update: Readonly<Record<string, unknown>>,
): SessionConfigOption[] | undefined {
  if (update.sessionUpdate !== "config_option_update" || !Array.isArray(update.configOptions))
    return undefined;
  return update.configOptions as SessionConfigOption[];
}

export function commandCodeBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return withDeadline(work, timeoutMs, () => new Error("Command Code ACP operation timed out"));
}
