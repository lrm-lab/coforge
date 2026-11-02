import { utf8Encoder } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionConfig } from "./daemon-connection-client";

/** The small heartbeat body; never serialize transport callbacks or server URLs from config. */
export function encodeDaemonConnectionStatus(config: DaemonConnectionConfig): Uint8Array {
  return utf8Encoder.encode(
    JSON.stringify({
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      workerInstanceId: config.workerInstanceId,
      startedAt: config.startedAt,
      online: true,
    }),
  );
}
