import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  directConversationIdBetween,
  visibleChannelIdByName,
} from "#src/server/conversations/channel-read-access.server";

import type { ArtifactActor } from "./artifact-access.server";

const CHANNEL_TARGET = /^#([a-z0-9][a-z0-9_-]{0,63})(?::(\S+))?$/;
const DM_TARGET = /^(?:dm:)?@([a-z0-9][a-z0-9_-]{0,63})(?:~(human|agent))?(?::(\S+))?$/;
const TASK_NUMBER = /^#[1-9]\d*$/;

export async function resolveArtifactTarget(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  target: string,
  actor?: ArtifactActor,
): Promise<string> {
  const [, channel, channelSuffix] = CHANNEL_TARGET.exec(target) ?? [];
  const [, peer, peerKind, peerSuffix] = DM_TARGET.exec(target) ?? [];
  if (!channel && !peer)
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-target",
      hint: "name #channel or @name (@name~agent for an Agent), or a thread of one",
    });
  const suffix = channelSuffix ?? peerSuffix;
  if (suffix !== undefined && TASK_NUMBER.test(suffix))
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-target-task",
      hint: `a task cannot be an artifact's home: name its conversation, ${channel ? `#${channel}` : `@${peer}`}`,
    });
  if (suffix?.startsWith("#"))
    throw new AppError("INVALID_INPUT", {
      errorId: "artifact-target",
      hint: "name #channel or @name (@name~agent for an Agent), or a thread of one",
    });
  const { workspaceId, agentId } = principal;
  const self: ArtifactActor = actor ?? { agentId };
  if (channel) {
    const id = await visibleChannelIdByName(db, workspaceId, channel);
    if (id === undefined) throw new AppError("NOT_FOUND");
    return id;
  }
  const [user, agent] = await Promise.all([
    peerKind === "agent"
      ? null
      : db.user.findFirst({
          where: { username: peer, memberships: { some: { workspaceId } } },
          select: { id: true },
        }),
    peerKind === "human"
      ? null
      : db.agent.findFirst({
          where: { workspaceId, name: peer, ...ACTIVE_AGENT_WHERE },
          select: { id: true },
        }),
  ]);
  const otherUser = user && (!("userId" in self) || user.id !== self.userId) ? user : null;
  const otherAgent = agent && (!("agentId" in self) || agent.id !== self.agentId) ? agent : null;
  if (otherUser && otherAgent)
    throw new AppError("AMBIGUOUS_TARGET", {
      hint: `@${peer} is a person and an Agent: name @${peer}~human or @${peer}~agent`,
    });
  const peerMember = otherUser
    ? { userId: otherUser.id }
    : otherAgent
      ? { agentId: otherAgent.id }
      : null;
  if (peerMember) {
    const id = await directConversationIdBetween(db, workspaceId, self, peerMember);
    if (id !== undefined) return id;
  }
  throw new AppError("NOT_FOUND");
}
