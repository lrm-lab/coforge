import { isValidMessageSender, type MessageSenderKind } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { SYSTEM_SENDER_LABEL } from "#src/features/profiles/person-name";
import { humanLabel, type HumanNames } from "#src/lib/human-label";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

type BrowserSender =
  | {
      user?: HumanNames | null;
      agent?: { name: string; displayName?: string | null } | null;
    }
  | null
  | undefined;

export function browserSenderName(sender: BrowserSender): string {
  if (!sender) return SYSTEM_SENDER_LABEL;
  if (sender.user) return humanLabel(sender.user);
  if (sender.agent) return sender.agent.displayName?.trim() || sender.agent.name;
  return SYSTEM_SENDER_LABEL;
}

type BrowserAvatarSender =
  | {
      userId?: string | null;
      agentId?: string | null;
      user?: { avatarObjectKey?: string | null } | null;
      agent?: {
        avatarMascot?: string | null;
        appBot?: {
          installation: {
            app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null };
          };
        } | null;
      } | null;
    }
  | null
  | undefined;

export function browserSenderAvatarUrl(
  sender: BrowserAvatarSender,
  workspaceId: string,
): string | null {
  if (sender?.userId)
    return workspaceUserAvatarUrl(workspaceId, sender.userId, sender.user?.avatarObjectKey ?? null);
  if (sender?.agentId)
    return agentFaceUrl({
      id: sender.agentId,
      avatarMascot: sender.agent?.avatarMascot,
      appBot: sender.agent?.appBot,
    });
  return null;
}

export type BrowserActor = {
  kind: "user" | "agent";
  id: string | undefined;
  name: string;
  avatarUrl: string | null;
  deleted: boolean;
};

export async function browserActors(
  db: Pick<PrismaClient, "user" | "agent">,
  workspaceId: string,
  ids: { userIds: Iterable<string>; agentIds: Iterable<string> },
) {
  const userIds = [...new Set(ids.userIds)];
  const agentIds = [...new Set(ids.agentIds)];
  const [users, agents] = await Promise.all([
    userIds.length === 0
      ? []
      : db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        }),
    agentIds.length === 0
      ? []
      : db.agent.findMany({
          where: { id: { in: agentIds }, workspaceId },
          select: {
            id: true,
            name: true,
            displayName: true,
            deletedAt: true,
            avatarMascot: true,
            appBot: APP_BOT_LOGO_SELECT,
          },
        }),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  return (ref: { userId: string | null; agentId: string | null }): BrowserActor => {
    const user = ref.userId ? userById.get(ref.userId) : undefined;
    const agent = ref.agentId ? agentById.get(ref.agentId) : undefined;
    return {
      kind: ref.agentId ? "agent" : "user",
      id: ref.agentId ?? ref.userId ?? undefined,
      name: browserSenderName({ user, agent }),
      avatarUrl: browserSenderAvatarUrl({ ...ref, user, agent }, workspaceId),
      deleted: Boolean(agent?.deletedAt),
    };
  };
}

export function browserSenderHandle(
  sender:
    | { user?: { username: string } | null; agent?: { name: string } | null }
    | null
    | undefined,
): string | undefined {
  if (!sender) return undefined;
  if (sender.user) return sender.user.username;
  if (sender.agent) return sender.agent.name;
  return undefined;
}

export class UnresolvedMessageSenderError extends Error {
  constructor(reason: string) {
    super(`Agent message sender could not be resolved: ${reason}`);
    this.name = "UnresolvedMessageSenderError";
  }
}

export type AgentMessageSender = {
  kind: MessageSenderKind;
  handle: string;
  description: string;
};

type AgentMessageSenderRelation =
  | {
      agentId: string | null;
      agent?: { name: string; description: string } | null;
      user?: { username: string; description: string } | null;
    }
  | null
  | undefined;

export const MESSAGE_SENDER_SELECT = {
  select: {
    agentId: true,
    agent: { select: { name: true, description: true } },
    user: { select: { username: true, description: true } },
  },
} satisfies NonNullable<Prisma.MessageInclude["sender"]>;

export function agentMessageSender(sender: AgentMessageSenderRelation): AgentMessageSender {
  if (!sender) return { kind: "system", handle: "", description: "" };
  if (sender.agentId) {
    const handle = sender.agent?.name;
    if (!handle) throw new UnresolvedMessageSenderError("Agent sender has no resolvable name");
    return wellFormed({ kind: "agent", handle, description: sender.agent?.description ?? "" });
  }
  const handle = sender.user?.username;
  if (!handle) throw new UnresolvedMessageSenderError("human sender has no resolvable username");
  return wellFormed({ kind: "human", handle, description: sender.user?.description ?? "" });
}

function wellFormed(sender: AgentMessageSender): AgentMessageSender {
  if (!isValidMessageSender(sender.kind, sender.handle))
    throw new UnresolvedMessageSenderError(`${sender.kind} sender is not a public @username`);
  return sender;
}
