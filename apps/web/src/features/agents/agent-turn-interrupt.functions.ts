import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userAgentTurnInterrupt } from "#src/server/agents/user-agent-control.server";

/**
 * Asks the Agent's Computer to stop the current turn and returns at once with the request to
 * poll, or with why nothing was asked: production closes a request idle for about ten seconds and
 * the Computer can take about fifteen. The outcome is read with `readAgentTurnInterrupt`.
 */
export const startAgentTurnInterrupt = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ agentId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return userAgentTurnInterrupt(db).start({ ...data, userId: user.id, workspaceId });
  });

/** The Computer's outcome of a started interrupt: pending, or what it did. */
export const readAgentTurnInterrupt = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ agentId: z.uuid(), requestId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return userAgentTurnInterrupt(db).read({ ...data, userId: user.id, workspaceId });
  });
