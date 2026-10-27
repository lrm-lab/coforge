import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { listAgentChannels } from "#src/server/agents/agent-channel-memberships.server";
import { agentIdSchema } from "./agent.schemas";

/** The channels an Agent belongs to, for its profile's Chat tab. */
export const getAgentChannels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return listAgentChannels(db, { workspaceId, agentId, userId: user.id });
  });
