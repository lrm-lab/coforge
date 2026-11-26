import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  loadWorkspaceAgentsSnapshot,
  statusAgentScopes,
  visiblePrivateAgentIds,
} from "#src/server/agents/agent-roster.server";
import { agentVisibilityViewerForUser } from "#src/server/agents/agent-visibility.server";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { agentStatusChannel, agentStatusChannelForAgent } from "./agent-status-channel";

export const loadWorkspaceAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    declareNoStore();
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id).catch(
      () => undefined,
    );
    const privateAgentIds = viewer
      ? await visiblePrivateAgentIds(db, workspaceId, viewer).catch(() => [])
      : [];
    const {
      streamPositions,
      data: { agents, extraAgents, statusAgents },
    } = await readAfterStreamPositions(
      [
        agentStatusChannel(workspaceId),
        ...privateAgentIds.map((agentId) => agentStatusChannelForAgent(workspaceId, agentId)),
      ],
      () => loadWorkspaceAgentsSnapshot(db, user.id, workspaceId, viewer),
    );
    return { agents, extraAgents, statusAgents, streamPositions };
  });

export const listStatusAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => {
    declareNoStore();
    return statusAgentScopes(db, workspaceId);
  });
