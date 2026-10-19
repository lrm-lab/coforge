import {
  client,
  type AnyMessage,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { JsonlProcess } from "#src/code-agent/jsonl-process";
import { asRecord } from "#src/code-agent/json-record";

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
    onUpdate: (method: string, params: RecordValue) => void,
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse,
  ) {
    this.process = new JsonlProcess(command, cwd, environment);
    let unsubscribe: (() => void) | undefined;
    const readable = new ReadableStream<AnyMessage>({
      start: (controller) => {
        unsubscribe = this.process.onRecord((value) => {
          // Extension handlers in the SDK dispatch asynchronously. Observe ordered native
          // updates here, before a later RPC response can finalize the same turn.
          if (
            value.method === "session/update" ||
            value.method === "_x.ai/queue/changed" ||
            value.method === "_x.ai/session_notification"
          ) {
            onUpdate(value.method, record(value.params));
          }
          controller.enqueue(value as AnyMessage);
        });
      },
      cancel: () => unsubscribe?.(),
    });
    this.connection = client({ name: "coforge-daemon" })
      .onNotification("session/update", () => {})
      .onNotification("_x.ai/queue/changed", record, () => {})
      .onNotification("_x.ai/session_notification", record, () => {})
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        readable,
        writable: new WritableStream<AnyMessage>({
          write: (message) => this.process.send(message),
        }),
      });
    this.process.onClose(() => this.connection.close());
    this.process.onFailure(() => this.connection.close());
  }

  async dispose() {
    this.connection.close();
    await this.process.dispose();
  }
}
