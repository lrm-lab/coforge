import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode, thrownMessage } from "@lrm/coforge-sdk/internal";
import { controlPayloadShape } from "./control-payload";

const logger = getLogger(["coforge", "daemon", "connection"]);

export function logRejectedControl(
  ids: { workspaceId: string; computerId: string },
  data: Uint8Array,
  rejections: readonly { kind: string; error: unknown }[],
): void {
  logger.warning("Rejected invalid Daemon control publication", {
    event: "daemon_control:rejected",
    workspace_id: ids.workspaceId,
    computer_id: ids.computerId,
    payload_bytes: data.byteLength,
    rejections: rejections.map(({ kind, error }) => `${kind}: ${thrownMessage(error)}`).join("; "),
    payload_shape: controlPayloadShape(data),
    error_code: diagnosticErrorCode(rejections.at(-1)?.error),
    outcome: "rejected",
  });
}
