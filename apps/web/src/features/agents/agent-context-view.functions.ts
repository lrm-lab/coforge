import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerAgentContextViews } from "#src/server/computers/computer-agent-context-views-production.server";
import {
  agentVisibilityViewerForUser,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";

const startSchema = z.object({
  computerId: z.string().min(1),
  agentId: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(32 * 1024 * 1024)
    .default(32 * 1024 * 1024),
});

/** The request a start returned; the result is read with it, scoped to the Computer and Agent. */
const readSchema = z.object({
  computerId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().regex(/^ctxv_[0-9a-f]{32}$/),
});

/**
 * Owner-only: asks the Computer to restore an Agent's context and returns at once with the
 * request to poll, because production closes a request idle for about ten seconds and the restore
 * can take about 25. The result is read with `readAgentContextView`, which
 * `awaitAgentContextView` polls.
 */
export const startAgentContextView = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    return computerAgentContextViews(db).start({ userId: user.id, workspaceId }, data);
  });

/** The Computer's result for a started view: pending, the result, or why it cannot be shown. */
export const readAgentContextView = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    return computerAgentContextViews(db).read({ userId: user.id, workspaceId }, data);
  });

/** Resolves the current native session and newest delivered message for the profile entry. */
export const resolveAgentContextViewTarget = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ agentId: z.string().min(1) }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, workspaceId, deletedAt: null },
      select: {
        id: true,
        computerId: true,
        visibility: true,
        ownerId: true,
        systemKind: true,
        currentSession: { select: { nativeSessionId: true } },
      },
    });
    if (agent && !canSeeAgent(viewer, agent))
      return { status: "unavailable" as const, reason: "no_computer" as const };
    const sessionId = agent?.currentSession?.nativeSessionId;
    if (!agent?.computerId)
      return { status: "unavailable" as const, reason: "no_computer" as const };
    if (!sessionId) return { status: "unavailable" as const, reason: "not_recorded" as const };
    const delivery =
      (await db.agentMessageDelivery.findFirst({
        where: { workspaceId, agentId: agent.id, mentionSessionId: sessionId },
        orderBy: [{ sequence: "desc" }, { createdAt: "desc" }],
        select: { messageId: true },
      })) ??
      (await db.agentMessageDelivery.findFirst({
        where: { workspaceId, agentId: agent.id, mentionSessionId: null },
        orderBy: [{ sequence: "desc" }, { createdAt: "desc" }],
        select: { messageId: true },
      }));
    if (!delivery) return { status: "unavailable" as const, reason: "not_recorded" as const };
    return {
      status: "ready" as const,
      computerId: agent.computerId,
      agentId: agent.id,
      messageId: delivery.messageId,
      sessionId,
    };
  });
