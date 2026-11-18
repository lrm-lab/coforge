import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode, thrownMessage } from "@lrm/coforge-sdk/internal";
import { controlPayloadShape } from "./control-payload";

const logger = getLogger(["coforge", "daemon", "connection"]);

type Ids = { workspaceId: string; computerId: string };
type Rejection = { kind: string; error: unknown };

export class RejectedControl {
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
    this.#refused(ids, data, rejections);
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
