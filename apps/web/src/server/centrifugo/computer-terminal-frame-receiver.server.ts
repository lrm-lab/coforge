import {
  decodeTerminalFrame,
  type ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { terminalAttachChannel } from "#src/features/computers/terminal/computer-terminal-channel";
import type { ComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

const TERMINAL_CLEARING_ERROR_CODES = new Set([
  "output_backpressure",
  "daemon_replaced",
  "permission_denied",
]);

export function createComputerTerminalFrameMethod(ports: {
  store: Pick<ComputerTerminalStore, "getSession" | "markOpened" | "clearSession">;
  publish(channel: string, bytes: Uint8Array, options?: { skipHistory?: boolean }): Promise<void>;
}): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    let frame: ComputerTerminalFrame;
    try {
      frame = decodeTerminalFrame(payload);
    } catch {
      return { code: 400, message: "Invalid computer terminal frame" };
    }
    if (
      principal.agentId ||
      principal.workspaceId !== frame.workspaceId ||
      principal.computerId !== frame.computerId ||
      principal.userId !== frame.ownerUserId
    ) {
      return { code: 403, message: "Terminal frame scope is not authorized" };
    }

    const scope = { workspaceId: frame.workspaceId, computerId: frame.computerId };
    const session = await ports.store.getSession(scope);
    if (
      !session ||
      session.ownerUserId !== frame.ownerUserId ||
      session.sessionId !== frame.sessionId ||
      !session.activeAttach ||
      session.activeAttach.attachId !== frame.attachId ||
      session.activeAttach.attachGeneration !== frame.attachGeneration ||
      (principal.workerInstanceId !== undefined &&
        principal.workerInstanceId !== session.daemonInstanceId) ||
      (frame.event.case === "opened" &&
        frame.event.value.daemonInstanceId !== session.daemonInstanceId)
    ) {
      return { code: 403, message: "Terminal attach is not authorized" };
    }

    if (frame.event.case === "opened") {
      await ports.store.markOpened(scope, {
        sessionId: frame.sessionId,
        attachId: frame.attachId,
        attachGeneration: frame.attachGeneration,
      });
    }

    await ports.publish(terminalAttachChannel(frame.attachId), payload, { skipHistory: true });

    if (
      frame.event.case === "closed" ||
      (frame.event.case === "error" && TERMINAL_CLEARING_ERROR_CODES.has(frame.event.value.code))
    ) {
      await ports.store.clearSession(scope, frame.sessionId);
    }

    return new Uint8Array();
  };
}
