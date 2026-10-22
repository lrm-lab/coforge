import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { PUBLIC_CHANNEL_WHERE } from "#src/server/conversations/active-member.server";

const WORKSPACE_SELECT = {
  id: true,
  slug: true,
  name: true,
  iconObjectKey: true,
  createdAt: true,
} satisfies Prisma.WorkspaceSelect;
const AGENT_SELECT = {
  id: true,
  name: true,
  displayName: true,
  description: true,
  avatarObjectKey: true,
  createdAt: true,
} satisfies Prisma.AgentSelect;
const CHANNEL_SELECT = {
  id: true,
  channelName: true,
  description: true,
  createdAt: true,
} satisfies Prisma.ConversationSelect;
const COMPUTER_SELECT = {
  id: true,
  name: true,
  displayName: true,
  kind: true,
  computerVersion: true,
} satisfies Prisma.ComputerSelect;

/** The rows an installed app may read, as the store returns them: only the columns the
 * projections need, so nothing else can leak by being selected. */
export type WorkspaceProfileRow = Prisma.WorkspaceGetPayload<{ select: typeof WORKSPACE_SELECT }>;
export type AgentProfileRow = Prisma.AgentGetPayload<{ select: typeof AGENT_SELECT }>;
export type ChannelProfileRow = Omit<
  Prisma.ConversationGetPayload<{ select: typeof CHANNEL_SELECT }>,
  "channelName"
> & { channelName: string };
export type ComputerProfileRow = Prisma.ComputerGetPayload<{ select: typeof COMPUTER_SELECT }>;

/**
 * Reads what an installed app may see, and filters it here: a private, deleted or platform-owned
 * (`systemKind`) Agent, a direct, archived or hidden conversation, and a deleted Computer never
 * leave the query. Each select names the few columns the projection needs.
 */
export class PrismaAppInstallationDataStore {
  constructor(private readonly db: PrismaClient) {}

  async workspace(workspaceId: string) {
    return (
      (await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: WORKSPACE_SELECT,
      })) ?? undefined
    );
  }

  agents(workspaceId: string) {
    return this.db.agent.findMany({
      where: {
        workspaceId,
        ...ACTIVE_AGENT_WHERE,
        visibility: AGENT_VISIBILITY.PUBLIC,
        systemKind: null,
      },
      select: AGENT_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async channels(workspaceId: string) {
    const channels = await this.db.conversation.findMany({
      where: { workspaceId, ...PUBLIC_CHANNEL_WHERE },
      select: CHANNEL_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return channels.flatMap(({ channelName, ...channel }) =>
      channelName === null ? [] : [{ ...channel, channelName }],
    );
  }

  async computers(workspaceId: string) {
    const links = await this.db.workspaceComputer.findMany({
      where: { workspaceId, computer: { deletedAt: null } },
      select: { computer: { select: COMPUTER_SELECT } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return links.map(({ computer }) => computer);
  }
}
