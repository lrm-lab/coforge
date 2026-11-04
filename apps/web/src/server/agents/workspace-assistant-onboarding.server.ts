import type { PrismaClient } from "#src/generated/prisma/client";
import type { Locale } from "#src/paraglide/runtime";
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

  async ensure(
    workspaceId: string,
    userId: string,
    { startIfOwed = false, locale }: { startIfOwed?: boolean; locale?: Locale } = {},
  ) {
    const assistants = new WorkspaceAssistants(this.db);
    const session = await assistants.ensure(workspaceId, userId, { locale });
    // The read path ends here: an existing session issues no writes at all. The start sequence
    // runs on provisioning (`session.created`) and on calls a write path marks `startIfOwed` —
    // Workspace creation, sign-in completion and link joins provision through several calls and
    // only bind the Computer after `ensure` returned, so `created` alone cannot reach them.
    if (!session.created && !startIfOwed) return session;
    try {
      let agent = await this.db.agent.findUniqueOrThrow({ where: { id: session.agentId } });
      if (agent.stoppedAt || agent.deletedAt) return session;
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

/**
 * Starts the member's assistant when it owes its introduction: not stopped, not mid-migration, and
 * `AgentIntroduction` carries a prompt, which it does not while the owner's setup wizard is still
 * pending or its mark is unreadable. `AgentControl.recover` holds its Starts on the same fact
 * (`holdsStart`), so the welcome waits for the wizard on every Start the member did not ask for.
 */
export function startAssistantIfOwed(
  db: PrismaClient,
  { agentId }: { agentId: string },
  publishStart: (
    agent: NonNullable<Awaited<ReturnType<PrismaAgentControlStore["get"]>>>,
  ) => Promise<unknown> = (agent) =>
    userAgentControl(db).publishStart(agentStartIntent(agent), agent.ownerId),
) {
  return getAgentRuntimeLock().run(agentId, async () => {
    const agent = await new PrismaAgentControlStore(db).get(agentId);
    if (
      !agent ||
      agent.systemKind !== WORKSPACE_ASSISTANT_KIND ||
      agent.stoppedAt ||
      agent.migrating
    )
      return;
    if (!(await createAgentIntroduction(db).promptFor(agent, new Date()))) return;
    await publishStart(agent);
  });
}

export function workspaceAssistantOnboarding(db: PrismaClient) {
  return new WorkspaceAssistantOnboarding(db, {
    startCloudComputer: (input) => productionCloudComputers(db).ensureDefault(input),
    startAgent: ({ agentId }) => startAssistantIfOwed(db, { agentId }),
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
