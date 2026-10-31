import type { PrismaClient } from "#src/generated/prisma/client";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import {
  defaultCloudComputerId,
  startDefaultCloudComputer,
} from "#src/server/workspaces/create-workspace.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { createAgentIntroduction } from "#src/server/db/repositories/agent-introduction.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";
import { WorkspaceAssistants } from "./workspace-assistants.server";
import { backfillWorkspaceAssistants } from "./workspace-assistants.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { getAgentRuntimeLock } from "./agent-runtime-lock.server";
import { userAgentControl } from "./user-agent-control.server";
import { agentStartIntent } from "./manage-agents.server";

type OnboardingPorts = {
  startCloudComputer(input: { workspaceId: string; userId: string; now: Date }): Promise<unknown>;
  startAgent(input: { workspaceId: string; userId: string; agentId: string }): Promise<void>;
};

/** Provisioning is durable before cloud/transport work; ready recovery retries a missed Start. */
export class WorkspaceAssistantOnboarding {
  constructor(
    private readonly db: PrismaClient,
    private readonly ports: OnboardingPorts,
  ) {}

  async ensure(workspaceId: string, userId: string) {
    const assistants = new WorkspaceAssistants(this.db);
    const session = await assistants.ensure(workspaceId, userId);
    try {
      let agent = await this.db.agent.findUniqueOrThrow({ where: { id: session.agentId } });
      if (agent.stoppedAt || agent.deletedAt) return session;
      const introduced = await this.db.message.findFirst({
        where: { conversationId: session.conversationId, sender: { agentId: agent.id } },
        select: { id: true },
      });
      if (introduced) {
        if (agent.introductionDueAt !== null)
          await this.db.agent.updateMany({
            where: { id: agent.id, introductionDueAt: { not: null } },
            data: { introductionDueAt: null },
          });
        return session;
      }
      // Upgrade pre-onboarding bindings too, with a stable time that repeated reads cannot renew.
      if (agent.introductionDueAt === null)
        await this.db.agent.updateMany({
          where: { id: agent.id, introductionDueAt: null },
          data: { introductionDueAt: agent.createdAt },
        });
      if (!agent.computerId) {
        const started = await startDefaultCloudComputer(this.ports.startCloudComputer, {
          workspaceId,
          userId,
          now: new Date(),
        });
        const computerId = defaultCloudComputerId(started);
        if (!computerId) return session;
        await assistants.bindComputer(workspaceId, userId, computerId);
        agent = await this.db.agent.findUniqueOrThrow({ where: { id: agent.id } });
      }
      if (agent.computerId) await this.ports.startAgent({ workspaceId, userId, agentId: agent.id });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "workspace_assistant:onboarding_pending",
          workspaceId,
          userId,
          errorType: errorType(error),
        }),
      );
    }
    return session;
  }
}

export function workspaceAssistantOnboarding(db: PrismaClient) {
  return new WorkspaceAssistantOnboarding(db, {
    startCloudComputer: (input) => productionCloudComputers(db).ensureDefault(input),
    startAgent: ({ userId, agentId }) =>
      getAgentRuntimeLock().run(agentId, async () => {
        const agent = await new PrismaAgentControlStore(db).get(agentId);
        if (
          !agent ||
          agent.systemKind !== WORKSPACE_ASSISTANT_KIND ||
          agent.stoppedAt ||
          agent.migrating
        )
          return;
        if (!(await createAgentIntroduction(db).promptFor(agent, new Date()))) return;
        await userAgentControl(db).publishStart(agentStartIntent(agent), userId);
      }),
  });
}

/** One bounded pass on Web boot reaches old members without waiting for them to visit. */
export function startWorkspaceAssistantOnboarding() {
  if (!Bun.env.DATABASE_URL) return;
  const db = requireDatabaseClient();
  void backfillWorkspaceAssistants(db, (workspaceId, userId) =>
    workspaceAssistantOnboarding(db).ensure(workspaceId, userId),
  ).catch((error) =>
    console.warn(
      JSON.stringify({
        event: "workspace_assistant:backfill_failed",
        errorType: errorType(error),
      }),
    ),
  );
}
