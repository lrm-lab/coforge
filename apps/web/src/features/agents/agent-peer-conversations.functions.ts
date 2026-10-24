import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { listAgentPeerCards } from "#src/server/agents/agent-peer-conversations.server";
import { agentIdSchema } from "./agent.schemas";

/** The Agent profile's card of its conversations with other Agents (previews only). */
export const getAgentPeerConversations = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return listAgentPeerCards(db, { workspaceId, agentId, userId: user.id });
  });
