import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import {
  readAgentRoster,
  statusAgentScopes,
  visiblePrivateAgentIds,
} from "#src/server/agents/agent-roster.server";
import { agentVisibilityViewerForUser } from "#src/server/agents/agent-visibility.server";
import { listExtraAgents } from "#src/server/agents/extra-agents.server";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { agentStatusChannel, agentStatusChannelForAgent } from "./agent-status-channel";

/**
 * The Workspace page's Agents as it loads: the viewer's roster (`listAgents`), the Agents beyond it
 * (`loadExtraAgents`; undefined if that read failed, and the browser reads them then), and where the
 * status channels the page subscribes to stood, read first, so each channel's first subscribe reads
 * them again only if its stream moved past it. Those are the Workspace's channel and one per private
 * Agent the viewer can see; a private Agent made after its ids are read has no position, and the
 * page reads again for it. A later refresh reads the two lists on their own, with no position.
 */
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
      data: [agents, extraAgents, statusAgents],
    } = await readAfterStreamPositions(
      [
        agentStatusChannel(workspaceId),
        ...privateAgentIds.map((agentId) => agentStatusChannelForAgent(workspaceId, agentId)),
      ],
      () =>
        Promise.all([
          readAgentRoster(db, user.id, workspaceId),
          viewer
            ? listExtraAgents(db, getAgentDisplay(), workspaceId, viewer).catch(() => undefined)
            : undefined,
          statusAgentScopes(db, workspaceId).catch(() => []),
        ]),
    );
    return { agents, extraAgents, statusAgents, streamPositions };
  });

/** Every live Agent's id and Computer in the Workspace, whatever the viewer may see — ids only,
 * so a refresh keeps the set of Agents the shared status channel may report on (task #587). */
export const listStatusAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => {
    declareNoStore();
    return statusAgentScopes(db, workspaceId);
  });
