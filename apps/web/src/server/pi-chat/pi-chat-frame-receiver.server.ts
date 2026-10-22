import { decodePiChatFrame, type PiChatFrame } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import type { PiChatScope } from "@lrm/coforge-sdk/internal/pi-chat";
import type { CentrifugoRpcMethod } from "#src/server/centrifugo/rpc-handler.server";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";

/** Authenticate each chunk before either caching a reply or routing private live feedback. */
export function createPiChatFrameMethod(ports: {
  canUse(scope: PiChatScope): Promise<boolean>;
  results: { accept(frame: PiChatFrame): Promise<void> };
  publish(channel: string, bytes: Uint8Array): Promise<void>;
}): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    let frame: PiChatFrame;
    try {
      frame = decodePiChatFrame(payload);
    } catch {
      return { code: 400, message: "Invalid Pi chat frame" };
    }
    if (
      principal.agentId ||
      principal.userId !== frame.userId ||
      principal.workspaceId !== frame.workspaceId ||
      principal.computerId !== frame.computerId ||
      !(await ports.canUse(frame))
    )
      return { code: 403, message: "Pi chat scope is not authorized" };
    if (frame.kind === "result") await ports.results.accept(frame);
    else await ports.publish(userConversationChannel(frame.userId), payload);
    return new Uint8Array();
  };
}
