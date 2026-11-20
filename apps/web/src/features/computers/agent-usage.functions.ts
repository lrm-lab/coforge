import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { userAgentUsage } from "#src/server/computers/agent-usage-composition.server";

const agentUsageInput = z.object({ agentId: z.uuid() }).strict();

export const readAgentUsage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentUsageInput)
  .handler(({ context, data }) => {
    declareNoStore();
    return userAgentUsage(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data.agentId,
    );
  });

export const scanAgentUsage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentUsageInput)
  .handler(({ context, data }) => {
    declareNoStore();
    return userAgentUsage(context.db).scan(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data.agentId,
    );
  });
