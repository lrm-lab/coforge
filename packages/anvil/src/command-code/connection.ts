import {
  client,
  type AnyMessage,
  type InitializeRequest,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
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
  constructor(
    command: readonly string[],
    modPath: string,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    private readonly host: CommandCodeRuntimeHost,
    onUpdate: (sessionId: string, update: Readonly<Record<string, unknown>>) => void = () => {},
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
      outcome: { outcome: "cancelled" },
    }),
    onPromptWrite: () => void = () => {},
  ) {
    // `--mod` is global and applies after `acp`. `--safe-mode` would skip it, so it is never set.
    this.process = new JsonlProcess(
      [...command, ...COMMAND_CODE_ACP_ARGS, "--mod", modPath],
      cwd,
      environment,
      host.processTreeSpawner,
    );
    this.connection = client({ name: host.clientInfo.name })
      .onNotification("session/update", () => {})
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        readable: this.process.records((record) => {
          if (record.method !== "session/update") return;
          const params = asRecord(record.params);
          const update = asRecord(params?.update);
          if (typeof params?.sessionId === "string" && update) onUpdate(params.sessionId, update);
        }) as ReadableStream<AnyMessage>,
        writable: new WritableStream<AnyMessage>({
          write: (message) => {
            if ("method" in message && message.method === "session/prompt") onPromptWrite();
            return this.process.send(message);
          },
        }),
      });
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
    this.connection.close();
    await this.process.dispose(options);
  }
}

export function commandCodeBounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return withDeadline(work, timeoutMs, () => new Error("Command Code ACP operation timed out"));
}
