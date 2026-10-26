import {
  client,
  type AnyMessage,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { JsonlProcess } from "#src/jsonl-process";
import { asRecord } from "#src/json-record";

import type { GrokConnectionHost } from "./host";

type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): RecordValue => {
  const parsed = asRecord(value);
  if (!parsed) throw new Error("Invalid Grok ACP notification");
  return parsed;
};

/** The maintained ACP SDK owns RPC validation; JsonlProcess owns the process tree. */
export class GrokConnection {
  readonly process: JsonlProcess;
  readonly connection;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    host: GrokConnectionHost,
    onUpdate: (method: string, params: RecordValue) => void,
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse,
  ) {
    this.process = new JsonlProcess(command, cwd, environment, host.processTreeSpawner);
    this.connection = client({ name: host.sessionClientInfo.name })
      .onNotification("session/update", () => {})
      .onNotification("_x.ai/queue/changed", record, () => {})
      .onNotification("_x.ai/session_notification", record, () => {})
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        // Extension handlers in the SDK dispatch asynchronously. Observe ordered native
        // updates as they arrive, before a later RPC response can finalize the same turn. The
        // stream ends with the process, so the SDK handles everything still queued first.
        readable: this.process.records((value) => {
          if (
            value.method === "session/update" ||
            value.method === "_x.ai/queue/changed" ||
            value.method === "_x.ai/session_notification"
          ) {
            onUpdate(value.method, record(value.params));
          }
        }) as ReadableStream<AnyMessage>,
        writable: new WritableStream<AnyMessage>({
          write: (message) => this.process.send(message),
        }),
      });
  }

  async dispose(options?: Readonly<{ cutoffAtMs?: number }>) {
    this.connection.close();
    await this.process.dispose(options);
  }
}
