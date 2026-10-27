import { appEventConversation } from "#src/server/app-agent-events/app-event-target.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  dmParentTarget,
  openDirectPeerConversation,
} from "./agent-peer-direct.repositories.server";

export async function resolveAgentConversationTarget(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  target: string;
  getChannel(parentTarget: string): Promise<{ id: string; channelName?: string | null }>;
  directConversation(userId: string): Promise<{ id: string }>;
  peerConversation(agentId: string): Promise<{ id: string }>;
}) {
  const parentTarget = input.target.split(":")[0]!;
  const isChannel = parentTarget.startsWith("#");
  let directPeerKind: "user" | "agent" | undefined;
  const conversation = isChannel
    ? await input.getChannel(parentTarget)
    : await (async () => {
        const appConversation = await appEventConversation(
          input.db,
          input.workspaceId,
          input.agentId,
          parentTarget,
        );
        if (appConversation) return appConversation;
        const opened = await openDirectPeerConversation(
          input.db,
          { workspaceId: input.workspaceId, agentId: input.agentId },
          dmParentTarget(input.target),
          { user: input.directConversation, agent: input.peerConversation },
        );
        directPeerKind = opened.peer.kind;
        return opened.conversation;
      })();
  return {
    conversation,
    isChannel,
    isUserAgentDirectConversation: directPeerKind === "user",
  };
}
