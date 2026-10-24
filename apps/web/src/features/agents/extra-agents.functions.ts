import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { agentVisibilityViewerForUser } from "#src/server/agents/agent-visibility.server";
import { listExtraAgents } from "#src/server/agents/extra-agents.server";

/** The Agents of the Workspace that the viewer may see beyond their own roster (`ExtraAgent`),
 * under the Members directory's visibility rule. */
export const loadExtraAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    declareNoStore();
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    return listExtraAgents(db, getAgentDisplay(), workspaceId, viewer);
  });
