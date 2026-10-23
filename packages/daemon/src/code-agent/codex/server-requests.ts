import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { JsonlProcess } from "#src/code-agent/jsonl-process";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

/** The daemon is non-interactive, so every request Codex sends to it is answered "method not
 * found" at once; an unanswered request leaves Codex waiting and the turn hanging. Registered
 * before the handshake so it covers the whole life of the process. */
export function rejectServerRequests(
  process: JsonlProcess,
  agentId: string | undefined,
  runtimeId: string | undefined,
): void {
  process.onRecord((record) => {
    const { id, method } = record;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      typeof method !== "string" ||
      record.result !== undefined ||
      record.error !== undefined
    )
      return;
    logger.warn("Codex app-server request rejected", {
      event: "codex.server_request.rejected",
      agent_id: agentId,
      runtime_id: runtimeId,
      method,
    });
    process
      .send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Codex app-server request "${method}" is not supported by the CoForge daemon`,
        },
      })
      .catch(() => undefined);
  });
}
