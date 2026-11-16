import { createServerFn } from "@tanstack/react-start";
import { createCloudAgentInputSchema } from "./agent.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { CreateCloudAgent } from "#src/server/agents/create-cloud-agent.server";
import { readCloudAgentComputer } from "#src/server/agents/cloud-agent-computer.server";
import { manageAgents } from "#src/server/agents/manage-agents-production.server";
import { agentStartIntent } from "#src/server/agents/manage-agents.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { publishAgentDirectoryChanged } from "#src/server/agents/agent-visibility-realtime.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

export const getCloudAgentComputer = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { user, db, workspaceId } }) =>
    readCloudAgentComputer(db, { userId: user.id, workspaceId }),
  );

export const createCloudAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(createCloudAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    const result = await new CreateCloudAgent({
      findByRequest: (workspaceId, createRequestId) =>
        db.agent.findUnique({
          where: { workspaceId_createRequestId: { workspaceId, createRequestId } },
          select: { id: true, ownerId: true, deletedAt: true, stoppedAt: true },
        }),
      cloudComputer: (principal) => readCloudAgentComputer(db, principal),
      create: (principal, input) => manageAgents(db).create(principal, input),
      start: (principal, agentId) =>
        getAgentRuntimeLock().run(agentId, async () => {
          const agents = new PrismaAgentRepository(db);
          const agent = await new PrismaAgentControlStore(db).get(agentId);
          if (
            !agent ||
            agent.workspaceId !== principal.workspaceId ||
            agent.ownerId !== principal.userId
          )
            throw new AppError("ACCESS_DENIED");
          if (agent.stoppedAt || (agent.state && agent.state.action !== "start")) return;
          await userAgentRuntimeControl(db, agents).start(
            agentStartIntent(agent),
            principal.userId,
          );
        }),
    }).execute({ userId: user.id, workspaceId, role }, data);
    if (result.status !== "unavailable") {
      await publishAgentDirectoryChanged(workspaceId, result.agentId, "created");
    }
    return result;
  });
