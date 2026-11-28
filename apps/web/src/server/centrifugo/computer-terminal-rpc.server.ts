import { COMPUTER_TERMINAL_FRAME_METHOD } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { revokeComputerTerminalBestEffort } from "#src/server/computers/computer-terminal-production.server";
import { getComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";
import { createComputerTerminalFrameMethod } from "./computer-terminal-frame-receiver.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export function computerTerminalRpcMethods(
  centrifugo: {
    publish(channel: string, bytes: Uint8Array, options?: { skipHistory?: boolean }): Promise<void>;
  } | null,
  unavailable: CentrifugoRpcMethod,
): Record<string, CentrifugoRpcMethod> {
  return {
    [COMPUTER_TERMINAL_FRAME_METHOD]: centrifugo
      ? createComputerTerminalFrameMethod({
          store: getComputerTerminalStore(),
          publish: (channel, bytes, options) => centrifugo.publish(channel, bytes, options),
        })
      : unavailable,
  };
}

export function revokeComputerTerminalOnShutdown(scope: {
  workspaceId: string;
  computerId: string;
}) {
  return revokeComputerTerminalBestEffort({
    ...scope,
    closeShell: false,
    notifyReason: "daemon_replaced",
  });
}
