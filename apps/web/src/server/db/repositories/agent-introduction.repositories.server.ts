import type { PrismaClient } from "#src/generated/prisma/client";
import {
  AgentIntroduction,
  type AgentIntroductionStore,
} from "#src/server/agents/agent-introduction.server";

/** `Agent.introductionDueAt`, and the canonical Messages that settle it. */
export class PrismaAgentIntroductionStore implements AgentIntroductionStore {
  constructor(private readonly db: PrismaClient) {}

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
}

export function createAgentIntroduction(db: PrismaClient) {
  return new AgentIntroduction(new PrismaAgentIntroductionStore(db));
}
