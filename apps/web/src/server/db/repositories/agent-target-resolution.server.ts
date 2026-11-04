import { AppError } from "#src/lib/app-error";
import { appEventConversation } from "#src/server/app-agent-events/app-event-target.server";
import {
  taskDiscussionAgentAccess,
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
  /** A read may land on a task's own conversation; a send/reply never does — its target is the
   * channel + a message anchor, a task discussion going through `coforge task reply`. */
  taskDiscussion?: boolean;
}) {
  const parentTarget = input.target.split(":")[0]!;
  const isChannel = parentTarget.startsWith("#");
  let directPeerKind: "user" | "agent" | undefined;
  const conversation = isChannel
    ? await (async () => {
        // `#channel:<uuid>` names the Task's own conversation (`task_thread`): the board's
        // access decides, not a message anchor (task #522). Anything that is not a full UUID —
        // a bare `#channel`, a short anchor — stays the channel + message-anchor path.
        // A `#channel:<uuid>` is exactly two segments — a trailing one is refused, not carried
        // into the resolution or the canonical target.
        const segments = input.target.split(":");
        const suffix = segments.length === 2 ? segments[1] : undefined;
        const taskThread =
          input.taskDiscussion &&
          suffix &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suffix)
            ? await input.db.conversation.findFirst({
                where: {
                  id: suffix,
                  kind: "task_thread",
                  workspaceId: input.workspaceId,
                  taskDiscussionOf: {
                    deletedAt: null,
                    // The `#` name must name the Task's own board channel — a DM's task
                    // discussion has no `channelName` and refuses the `#` form.
                    conversation: { channelName: parentTarget.slice(1) },
                  },
                },
                select: {
                  id: true,
                  ...taskDiscussionBoardSelect({ agentId: input.agentId }),
                },
              })
            : null;
        if (taskThread) {
          if (taskDiscussionAgentAccess(taskThread) !== "read") throw new AppError("NOT_FOUND");
          const channelName = taskThread.taskDiscussionOf!.conversation.channelName!;
          return { ...taskThread, channelName, isTaskDiscussionTarget: true as const };
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
