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
} from "#src/server/conversations/pending-mention-views.server";

/** `GET /api/agent/v1/mention-actions/pending[?limit=<n>]` — `coforge mention pending`: the
 * calling Agent's mentions that reached no one because the target was outside the channel at send
 * time, oldest first. A page is `limit` rows (default 50, at most 100) of those that still allow
 * an action, and `hasMore` says whether more of them remain. A row that allows none (the target
 * joined, the channel was archived) cannot be acted on and does not take a place in the page: they
 * are only counted, as `noLongerActionable`, so the Agent still knows those mentions went unseen. */
export async function handleAgentMentionPendingGet(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  deps: {
    pendingMentionActions(
      workspaceId: string,
      agentId: string,
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
  const rows = await deps.pendingMentionActions(principal.workspaceId, principal.agentId);
  const actionable = rows.filter((row) => row.availableActions.length > 0);
  const body: AgentMentionPendingResponse = {
    ok: true,
    hasMore: actionable.length > limit,
    noLongerActionable: rows.length - actionable.length,
    pendingMentionActions: actionable.slice(0, limit).map((action) => ({
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
          pendingMentionActions: async (workspaceId, agentId) => {
            const user = await workspaceAssistantUser(db, workspaceId, agentId);
            return pendingMentionActionsForActor(
              db,
              workspaceId,
              user ? { userId: user.userId } : { agentId },
            );
          },
        }),
    },
  },
});
