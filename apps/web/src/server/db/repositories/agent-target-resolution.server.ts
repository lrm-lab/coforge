import { AppError } from "#src/lib/app-error";
import { appEventConversation } from "#src/server/app-agent-events/app-event-target.server";
import {
  taskDiscussionAccess,
  taskDiscussionBoardSelect,
} from "#src/server/conversations/task-discussion-access.server";
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
    ? await (async () => {
        // `#channel:<id>` names the channel, then a thread anchor — or the Task's own
        // conversation (`task_thread`) its discussion lives in, which the board's access
        // decides, not a message anchor (task #522).
        const taskThread = await input.db.conversation.findFirst({
          where: {
            id: input.target.split(":")[1] ?? "",
            kind: "task_thread",
            workspaceId: input.workspaceId,
          },
          select: {
            id: true,
            ...taskDiscussionBoardSelect({ agentId: input.agentId }),
          },
        });
        if (taskThread) {
          if (taskDiscussionAccess(taskThread) !== "read") throw new AppError("NOT_FOUND");
          return { ...taskThread, isTaskDiscussionTarget: true as const };
        }
        return input.getChannel(parentTarget);
      })()
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
