import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { createFileRoute } from "@tanstack/react-router";
import {
  MENTION_PENDING_DEFAULT_LIMIT,
  MENTION_PENDING_MAX_LIMIT,
  type AgentMentionPendingResponse,
} from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  pendingMentionActionsForActor,
  type PendingMentionActionView,
} from "#src/server/conversations/pending-mention-actions.server";

/** `GET /api/agent/v1/mention-actions/pending[?limit=<n>]` — `coforge mention pending`: the
 * calling Agent's mentions that reached no one because the target was outside the channel at send
 * time, oldest first. A page is `limit` rows (default 50, at most 100) and `hasMore` says whether
 * older-than-page-end ones remain; there is no cursor, so rows beyond the maximum page stay out of
 * reach until some of these are resolved or expire. */
export async function handleAgentMentionPendingGet(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  deps: {
    pendingMentionActions(
      workspaceId: string,
      agentId: string,
      limit: number,
    ): Promise<PendingMentionActionView[]>;
  },
): Promise<Response> {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? MENTION_PENDING_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MENTION_PENDING_MAX_LIMIT)
    return Response.json(
      { error: `limit must be an integer from 1 to ${MENTION_PENDING_MAX_LIMIT}` },
      { status: 400 },
    );
  // One row past the page tells whether another page exists.
  const rows = await deps.pendingMentionActions(
    principal.workspaceId,
    principal.agentId,
    limit + 1,
  );
  const actions = rows.slice(0, limit);
  const body: AgentMentionPendingResponse = {
    ok: true,
    hasMore: rows.length > limit,
    pendingMentionActions: actions.map((action) => ({
      resolutionId: action.resolutionId,
      messageId: action.messageId,
      targetType: action.targetType,
      targetHandle: action.targetHandle,
      targetAvatarUrl: action.targetAvatarUrl,
      reason: "not_member",
      availableActions: [...action.availableActions],
      expiresAt: action.expiresAt.toISOString(),
      channelName: action.channelName,
    })),
  };
  return Response.json(body);
}

export const Route = createFileRoute("/api/agent/v1/mention-actions_/pending")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentMentionPendingGet(request, principal, {
          pendingMentionActions: async (workspaceId, agentId, limit) => {
            const user = await workspaceAssistantUser(db, workspaceId, agentId);
            return pendingMentionActionsForActor(
              db,
              workspaceId,
              user ? { userId: user.userId } : { agentId },
              new Date(),
              limit,
            );
          },
        }),
    },
  },
});
