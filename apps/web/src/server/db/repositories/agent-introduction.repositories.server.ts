import type { PrismaClient } from "#src/generated/prisma/client";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  AgentIntroduction,
  type AgentIntroductionStore,
  type AgentIntroductionSubject,
} from "#src/server/agents/agent-introduction.server";

/** `Agent.introductionDueAt`, and the canonical Messages that settle it. */
export class PrismaAgentIntroductionStore implements AgentIntroductionStore {
  constructor(private readonly db: PrismaClient) {}

  async setupFacts(workspaceId: string, ownerId: string) {
    const [mark, preference] = await Promise.all([
      this.db.workspaceMemberPreference.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: ownerId } },
        select: { onboardingPendingSince: true },
      }),
      this.db.userPreference.findUnique({ where: { userId: ownerId }, select: { role: true } }),
    ]);
    return {
      onboardingPending: Boolean(mark?.onboardingPendingSince),
      ownerRole: preference?.role ?? null,
    };
  }

  async hasAgentMessage(input: {
    workspaceId: string;
    agentId: string;
    directKey: string;
    since: Date;
  }) {
    const conversation = await this.db.conversation.findUnique({
      where: {
        workspaceId_directKey: { workspaceId: input.workspaceId, directKey: input.directKey },
      },
      select: { id: true },
    });
    if (!conversation) return false;
    const message = await this.db.message.findFirst({
      where: {
        conversationId: conversation.id,
        sender: { agentId: input.agentId },
        createdAt: { gte: input.since },
      },
      select: { id: true },
    });
    return message !== null;
  }

  async settle(input: { workspaceId: string; agentId: string; ownerId: string }) {
    await this.db.agent.updateMany({
      where: {
        id: input.agentId,
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        introductionDueAt: { not: null },
      },
      data: { introductionDueAt: null },
    });
  }

  async workspaceFacts(agent: AgentIntroductionSubject) {
    const platformAssistant = agent.systemKind === WORKSPACE_ASSISTANT_KIND;
    const workspace = await this.db.workspace.findUniqueOrThrow({
      where: { id: agent.workspaceId },
      select: {
        newAgentGreeting: true,
        // Only a platform assistant's welcome depends on the owner's membership.
        ...(platformAssistant && {
          members: { where: { userId: agent.ownerId }, select: { assistantWelcome: true } },
        }),
      },
    });
    return {
      assistantWelcome: workspace.members?.[0]?.assistantWelcome ?? true,
      greetGeneral:
        workspace.newAgentGreeting &&
        agent.introductionDueAt != null &&
        (await canGreetGeneral(this.db, {
          workspaceId: agent.workspaceId,
          visibility: agent.visibility ?? "",
          systemKind: agent.systemKind ?? null,
        })),
    };
  }
}

export function createAgentIntroduction(db: PrismaClient) {
  return new AgentIntroduction(new PrismaAgentIntroductionStore(db));
}

/**
 * Whether a new Agent can introduce itself in `#general`: it is an ordinary public Agent (a public
 * one is in `#general` from creation, or joins it on the way to posting; a private one never
 * can), and `#general` is neither hidden from the Workspace nor archived.
 */
export async function canGreetGeneral(
  db: Pick<PrismaClient, "conversation">,
  agent: { workspaceId: string; visibility: string; systemKind: string | null },
) {
  if (agent.visibility !== AGENT_VISIBILITY.PUBLIC || agent.systemKind !== null) return false;
  const general = await db.conversation.findFirst({
    where: {
      workspaceId: agent.workspaceId,
      channelName: "general",
      hiddenFromWorkspaceAt: null,
      archivedAt: null,
    },
    select: { id: true },
  });
  return general !== null;
}
