import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { AgentSendDecisionResponse } from "@lrm/coforge-sdk/agent";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";
import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { workspaceAssistantUser } from "./workspace-assistant-authority.server";
import {
  WorkspaceAssistantCommands,
  type WorkspaceAssistantPrincipal,
} from "./workspace-assistant-commands.server";
import {
  agentIdempotencyKeyFromQuery,
  agentRouteDomainErrorResponse,
} from "./agent-http-routes.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";

const sendSchema = z.object({
  target: z.string().min(1),
  content: z.string().max(64000).optional(),
  idempotencyKey: z.string().min(1),
  reconcileOnly: z.boolean().optional(),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});
const readSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
  fromSequence: z.coerce.number().int().nonnegative().optional(),
  throughSequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** The native CLI keeps its existing wire contract. Only a bound platform assistant's requests
 * outside its private DM delegate to the verified member; every ordinary Agent falls through. */
export async function handleWorkspaceAssistantCommand(
  request: Request,
  principal: WorkspaceAssistantPrincipal,
  db: PrismaClient,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const messageAction = url.pathname.match(
    /^\/api\/agent\/v1\/messages\/([^/]+)\/(resolve|reactions)$/,
  );
  if (
    !messageAction &&
    !["/api/agent/v1/messages", "/api/agent/v1/events", "/api/agent/v1/messages/search"].includes(
      url.pathname,
    )
  )
    return undefined;
  const user = await workspaceAssistantUser(db, principal.workspaceId, principal.agentId);
  if (!user) return undefined;
  try {
    const commands = new WorkspaceAssistantCommands(db);
    if (messageAction) {
      const resolved = await commands.resolve(principal, decodeURIComponent(messageAction[1]!));
      if (resolved.ownAssistant) return undefined;
      if (messageAction[2] === "resolve" && request.method === "GET")
        return Response.json({
          idempotencyKey: agentIdempotencyKeyFromQuery(request),
          message: resolved.message,
        });
      if (messageAction[2] === "reactions" && ["POST", "DELETE"].includes(request.method)) {
        const body = z
          .object({ idempotencyKey: z.string().min(1), emoji: z.string().min(1) })
          .parse(await request.clone().json());
        const active = request.method === "POST";
        await toggleUserMessageReaction(
          db,
          new CentrifugoConversationRealtime(createCentrifugoServerApi()),
          {
            workspaceId: principal.workspaceId,
            conversationId: resolved.conversationId,
            userId: resolved.userId,
            messageId: resolved.message.id,
            emoji: body.emoji,
            active,
          },
        );
        return Response.json({
          idempotencyKey: body.idempotencyKey,
          messageId: resolved.message.id,
          emoji: body.emoji,
          active,
        });
      }
      return undefined;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/v1/messages") {
      const body = sendSchema.parse(await request.clone().json());
      if (body.target.split(":")[0] === `@${user.username}`) return undefined;
      if (body.reconcileOnly) {
        const record = await getMessageRequestIdempotency().find({
          workspaceId: principal.workspaceId,
          senderKind: "user",
          senderId: user.userId,
          idempotencyKey: body.idempotencyKey,
        });
        if (record?.state === "processing") throw new MessageRequestInProgressError();
        return Response.json(
          record?.state === "completed"
            ? {
                idempotencyKey: body.idempotencyKey,
                state: "committed",
                reconciliation: true,
                receiptComplete: false,
                messageId: record.message.id,
              }
            : { idempotencyKey: body.idempotencyKey, state: "not_found", reconciliation: true },
        );
      }
      if (body.content === undefined || (!body.content.trim() && !body.attachmentIds?.length))
        return Response.json({ error: "content is required" }, { status: 400 });
      const message = await commands.send(principal, { ...body, content: body.content });
      const response: AgentSendDecisionResponse = {
        idempotencyKey: body.idempotencyKey,
        state: "sent",
        decision: "bypass",
        messageId: message.id,
        ...("pendingMentionActions" in message
          ? {
              pendingMentionActions: message.pendingMentionActions.map((action) => ({
                resolutionId: action.resolutionId,
                messageId: action.messageId,
                targetType: action.targetType,
                targetHandle: action.targetHandle,
                targetAvatarUrl: action.targetAvatarUrl,
                reason: "not_member" as const,
                availableActions: [...action.availableActions],
                expiresAt: action.expiresAt.toISOString(),
              })),
            }
          : {}),
        ...("unresolvedMentionHandles" in message
          ? { unresolvedMentionHandles: message.unresolvedMentionHandles }
          : {}),
      };
      return Response.json(response);
    }
    if (request.method !== "GET") return undefined;
    const target = url.searchParams.get("target");
    if (target?.split(":")[0] === `@${user.username}`) return undefined;
    if (!target && url.pathname !== "/api/agent/v1/messages/search") return undefined;
    const idempotencyKey = agentIdempotencyKeyFromQuery(request);
    if (url.pathname === "/api/agent/v1/messages/search") {
      const window = readSchema.parse(Object.fromEntries(url.searchParams));
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      if (
        (after && !Number.isFinite(Date.parse(after))) ||
        (before && !Number.isFinite(Date.parse(before)))
      )
        return Response.json({ error: "invalid search dates" }, { status: 400 });
      const results = await commands.search(principal, {
        target: target ?? undefined,
        sender: url.searchParams.get("sender") ?? undefined,
        query: url.searchParams.get("query") ?? undefined,
        before: before ? new Date(before) : undefined,
        after: after ? new Date(after) : undefined,
        sort: url.searchParams.get("sort") === "recent" ? "recent" : "relevance",
        limit: window.limit ?? 20,
        offset: z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(url.searchParams.get("offset") ?? 0),
      });
      return Response.json({ idempotencyKey, results });
    }
    if (url.pathname === "/api/agent/v1/events")
      return Response.json({
        idempotencyKey,
        ...(await commands.check(
          principal,
          target!,
          readSchema.parse(Object.fromEntries(url.searchParams)).limit,
        )),
      });
    const result = await commands.read(
      principal,
      target!,
      readSchema.parse(Object.fromEntries(url.searchParams)),
    );
    return Response.json({ idempotencyKey, ...result });
  } catch (error) {
    if (error instanceof MessageRequestInProgressError)
      return Response.json(
        { error: error.message, code: "MESSAGE_REQUEST_IN_PROGRESS", retryable: true },
        { status: 409 },
      );
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid assistant command" }, { status: 400 });
    return agentRouteDomainErrorResponse(error, "assistant command failed");
  }
}
