import { getLogger } from "@logtape/logtape";
import {
  decodeAgentStartIntentScope,
  diagnosticErrorCode,
  thrownMessage,
  type AgentControlScope,
} from "@lrm/coforge-sdk/internal";
import { ListenerSlot } from "./listener-slot";
import { controlPayloadShape } from "./control-payload";

const logger = getLogger(["coforge", "daemon", "connection"]);

type Ids = { workspaceId: string; computerId: string };
type Rejection = { kind: string; error: unknown };

export class RejectedControl {
  readonly #start = new ListenerSlot<(scope: AgentControlScope) => void>();

  onStart(callback: (scope: AgentControlScope) => void): () => void {
    return this.#start.set(callback);
  }

  decodeFirst(
    decoders: readonly { kind: string; decode: () => void }[],
    data: Uint8Array,
    ids: Ids,
  ) {
    const rejections: Rejection[] = [];
    for (const { kind, decode } of decoders) {
      try {
        decode();
        return;
      } catch (error) {
        rejections.push({ kind, error });
      }
    }
    this.#answerStart(data);
    this.#refused(ids, data, rejections);
  }

  #answerStart(data: Uint8Array): void {
    try {
      const scope = decodeAgentStartIntentScope(data);
      if (scope) this.#start.current?.(scope);
    } catch {}
  }

  #refused(ids: Ids, data: Uint8Array, rejections: readonly Rejection[]): void {
    logger.warning("Rejected invalid Daemon control publication", {
      event: "daemon_control:rejected",
      workspace_id: ids.workspaceId,
      computer_id: ids.computerId,
      payload_bytes: data.byteLength,
      rejections: rejections
        .map(({ kind, error }) => `${kind}: ${thrownMessage(error)}`)
        .join("; "),
      payload_shape: controlPayloadShape(data),
      error_code: diagnosticErrorCode(rejections.at(-1)?.error),
      outcome: "rejected",
    });
  }
}
