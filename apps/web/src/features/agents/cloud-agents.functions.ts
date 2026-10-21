import { computerCanRunAgent } from "#src/server/agents/computer-runtime-availability.server";
import { createServerFn } from "@tanstack/react-start";
import { createCloudAgentInputSchema } from "./agent.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { CreateCloudAgent } from "#src/server/agents/create-cloud-agent.server";
import { manageAgents } from "#src/server/agents/manage-agents-production.server";
import { agentStartIntent } from "#src/server/agents/manage-agents.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { publishAgentDirectoryChanged } from "#src/server/agents/agent-visibility-realtime.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";

export const createCloudAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(createCloudAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    const result = await new CreateCloudAgent({
      find: (workspaceId, name) =>
        db.agent.findUnique({
          where: { workspaceId_name: { workspaceId, name } },
          select: { id: true, ownerId: true, deletedAt: true, stoppedAt: true },
        }),
      ensureComputer: ({ userId, workspaceId }) =>
        productionCloudComputers(db).ensureDefault({
          userId,
          workspaceId,
          now: new Date(),
        }),
      canRun: (principal, computerId, selection) =>
        computerCanRunAgent(db, principal, computerId, selection),
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
          // A creation retry must not supersede a newer user Stop/Restart/Reset.
          if (agent.stoppedAt || (agent.state && agent.state.action !== "start")) return;
          await userAgentRuntimeControl(db, agents).start(
            agentStartIntent(agent),
            principal.userId,
          );
        }),
    }).execute({ userId: user.id, workspaceId, role }, data);
    if (result.status !== "preparing") {
      try {
        await publishAgentDirectoryChanged(workspaceId, result.agentId, "created");
      } catch {
        // Focus/reconnect repairs a missed directory signal after the committed create.
      }
    }
    return result;
  });
