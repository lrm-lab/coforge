import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import { agentIdSchema } from "./agent.schemas";

/** The Agent card's recent Activity, for the Agents the viewer manages. */
export const getWorkspaceActivity = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    declareNoStore();
    const agents = await new AgentActivityRepository(db).listForManager(workspaceId, user.id);
    return {
      workspaceId,
      agents: agents.map((agent) => ({
        ...agent,
        activity: agent.activity,
      })),
    };
  });

/** The Agent detail Activity tab's feed, without the rest of `getAgentDetail`'s payload: for the
 * Agent's creator or a Workspace owner/admin, as the tab is. */
export const getAgentActivityFeed = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    const feed = await new AgentActivityRepository(db).feedForManager(
      workspaceId,
      user.id,
      agentId,
    );
    if (!feed) throw new Error("Agent not found");
    declareNoStore();
    return feed;
  });
