import { createServerFn } from "@tanstack/react-start";

import { loadExtraAgentsInputSchema } from "#src/features/agents/agent.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { agentVisibilityViewerForUser } from "#src/server/agents/agent-visibility.server";
import { listExtraAgents } from "#src/server/agents/extra-agents.server";

/** The Agents of the Workspace that the viewer may see beyond their own roster (`ExtraAgent`),
 * under the Members directory's visibility rule, with a display for the busy ones and the held
 * ones only. POST because the held ids are a body. */
export const loadExtraAgents = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(loadExtraAgentsInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    return listExtraAgents(db, getAgentDisplay(), workspaceId, viewer, data.heldAgentIds);
  });
