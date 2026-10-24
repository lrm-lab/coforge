import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userAgentTurnInterrupt } from "#src/server/agents/user-agent-control.server";

const input = z.object({ agentId: z.uuid(), requestId: z.uuid() });

export const interruptAgentTurn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(input)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    return userAgentTurnInterrupt(db).interrupt({
      ...data,
      userId: user.id,
      workspaceId,
    });
  });
