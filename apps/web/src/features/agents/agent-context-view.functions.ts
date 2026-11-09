import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerAgentContextViews } from "#src/server/computers/computer-agent-context-views-production.server";

const requestSchema = z.object({
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

/** Owner-only request seam used by the Agent profile context view entry. */
export const requestAgentContextView = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(requestSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    return computerAgentContextViews(db).view({ userId: user.id, workspaceId }, data);
  });

/** Resolves the current native session and newest delivered message for the profile entry. */
export const resolveAgentContextViewTarget = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ agentId: z.string().min(1) }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, workspaceId, ownerId: user.id, deletedAt: null },
      select: {
        id: true,
        computerId: true,
        currentSession: { select: { nativeSessionId: true } },
      },
    });
    const sessionId = agent?.currentSession?.nativeSessionId;
    if (!agent?.computerId || !sessionId) return { status: "unavailable" as const };
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
    if (!delivery) return { status: "unavailable" as const };
    return {
      status: "ready" as const,
      computerId: agent.computerId,
      agentId: agent.id,
      messageId: delivery.messageId,
      sessionId,
    };
  });
